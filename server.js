import express from 'express';
import { chromium, firefox, webkit } from 'playwright';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from "url";
import config from './config.json' assert { type: 'json' };

const app = express();
const PORT = 3000;

// Add these lines for static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
const browsers = {chromium, firefox, webkit };

// Store browser sessions temporarily
const activeSessions = new Map();

// Modified login function - just opens LinkedIn and waits for manual login
async function openLinkedInForManualLogin(page, sessionId) {
  try {
    await page.goto('https://www.linkedin.com/login');
    console.log(`🔐 Please login manually in the browser for session: ${sessionId}`);
    
    // Wait for user to login manually (check if we're redirected to feed)
    await page.waitForURL('**/feed/**', { timeout: 300000 }); // 5 minutes timeout
    console.log('✅ Manual login successful!');
    return true;
  } catch (error) {
    console.error('❌ Manual login failed or timed out:', error.message);
    return false;
  }
}

async function searchPeople(page, searchQuery) {
  try {
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`;
    await page.goto(searchUrl);
    const selectors = ['.search-results-container', '[data-test-id="search-results"]',
                       '.search-result', '.reusable-search__result-container'
    ];
    let loaded = false;
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        loaded = true;
        break;
      } 
      catch (e) { continue; } }
    if (!loaded) { throw new Error('Search results did not load properly'); }
    console.log(`🔍 Searching for: ${searchQuery}`);
    return true;
  }
  catch (error) { console.error('❌ Search failed:', error.message);  return false;}
}

async function extractProfileUrlsFromPage(page) {
  try {
    await page.waitForTimeout(2000);
    const profileUrls = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
      return links
        .map(link => link.href.split('?')[0]) 
        .filter(url => {
          const pathname = new URL(url).pathname;
          const publicProfilePattern = /^\/in\/[a-zA-Z0-9\-]+\/?$/;
          return (
            publicProfilePattern.test(pathname) &&            
            !url.includes('miniProfileUrn') &&               
            !pathname.includes('ACoA')                       
          );
        }).filter((url, index, self) => self.indexOf(url) === index); 
    });
    return profileUrls;
  } 
  catch (error) { console.error('❌ Failed to extract profile URLs:', error.message); return []; }
}

async function goToNextPage(page) {
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    try {
      await page.waitForSelector('.artdeco-pagination', { timeout: 5000 });
    } 
    catch { return false; }
    const nextSelectors = [
      'button.artdeco-pagination__button--next[aria-label="Next"]:not([disabled])',
      'button.artdeco-button--tertiary.artdeco-pagination__button--next',
      'button:has(span.artdeco-button__text:has-text("Next"))'
    ];
    for (const selector of nextSelectors) {
      try {
        const nextButton = await page.$(selector);
        if (!nextButton || !(await nextButton.isVisible())) continue;
        const buttonState = await nextButton.evaluate(button => ({
          disabled: button.disabled,
          ariaDisabled: button.getAttribute('aria-disabled'),
          buttonText: button.querySelector('.artdeco-button__text')?.innerText?.trim()
        }));
        const isClickable = !buttonState.disabled && buttonState.ariaDisabled !== 'true' &&
                            buttonState.buttonText === 'Next';
        if (!isClickable) continue;
        const currentUrl = page.url();
        const currentPageMatch = currentUrl.match(/&page=(\d+)/);
        const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : 1;
        await nextButton.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        try {  await nextButton.click(); }
        catch { await nextButton.click({ force: true }); }
        try {
          await Promise.race([
            page.waitForURL(new RegExp(`page=${currentPage + 1}`), { timeout: 8000 }),
            page.waitForLoadState('networkidle', { timeout: 8000 }),
            page.waitForTimeout(4000)
          ]);
        } catch {}
        const newUrl = page.url();
        const newPageMatch = newUrl.match(/&page=(\d+)/);
        const newPage = newPageMatch ? parseInt(newPageMatch[1]) : 1;
        if (newPage > currentPage || newUrl !== currentUrl) {
          return true;
        }
      } catch {}
    }
    return false;
  }
  catch { return false; }
}

// Smart delay function to avoid rate limiting
async function smartDelay(page, baseDelay = 2000) {
  // Random delay between 2-5 seconds
  const randomDelay = baseDelay + Math.random() * 3000;
  
  // Check if we need longer delay (detect rate limiting signs)
  const needsLongerDelay = await page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    return bodyText.includes('too many requests') || 
           bodyText.includes('rate limit') ||
           bodyText.includes('slow down') ||
           bodyText.includes('unusual activity') ||
           bodyText.includes('temporarily restricted');
  });
  
  if (needsLongerDelay) {
    console.log('⏳ Rate limiting detected, using longer delay...');
    await page.waitForTimeout(randomDelay * 3); // 6-15 seconds
  } else {
    await page.waitForTimeout(randomDelay);
  }
}

export async function extractProfileData(page, profileUrl) {
  try {
    console.log(`🔍 Navigating to: ${profileUrl}`);
    
    // Navigate with better error handling
    await page.goto(profileUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    // Wait for page to stabilize
    await page.waitForTimeout(3000);
    
    // Check if we're being rate limited or blocked
    const isBlocked = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      return bodyText.includes('challenge') || 
             bodyText.includes('unusual activity') ||
             bodyText.includes('temporarily restricted') ||
             bodyText.includes('verify that you\'re human');
    });
    
    if (isBlocked) {
      console.log('⚠️ Rate limiting detected, waiting longer...');
      await page.waitForTimeout(10000);
    }
    
    // Multiple strategies to detect if profile loaded
    const profileLoadStrategies = [
      // Strategy 1: Wait for any name selector
      async () => {
        const nameSelectors = config.selectors.name;
        for (const selector of nameSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 3000 });
            return true;
          } catch (e) { continue; }
        }
        return false;
      },
      
      // Strategy 2: Wait for profile image
      async () => {
        try {
          await page.waitForSelector('.pv-top-card__photo, .profile-photo-edit__preview, img[data-anonymize="headshot-photo"]', { timeout: 3000 });
          return true;
        } catch (e) { return false; }
      },
      
      // Strategy 3: Wait for any profile content
      async () => {
        try {
          await page.waitForSelector('.profile, .pv-profile-section, .top-card-layout', { timeout: 3000 });
          return true;
        } catch (e) { return false; }
      }
    ];
    
    // Try each strategy
    let profileLoaded = false;
    for (const strategy of profileLoadStrategies) {
      if (await strategy()) {
        profileLoaded = true;
        break;
      }
    }
    
    if (!profileLoaded) {
      // Final attempt - scroll and wait
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(2000);
      
      // Check one more time
      const hasContent = await page.evaluate(() => {
        return document.querySelector('h1') || 
               document.querySelector('.profile') ||
               document.querySelector('.pv-profile-section') ||
               document.body.innerText.length > 100;
      });
      
      if (!hasContent) {
        throw new Error('Profile content not accessible - possibly private or restricted');
      }
    }
    
    // Enhanced data extraction using config selectors
    const profileData = await page.evaluate((selectors) => {
      // Enhanced getText function with multiple fallbacks
      const getText = (selectorArray) => {
        if (typeof selectorArray === 'string') selectorArray = [selectorArray];
        
        for (const selector of selectorArray) {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            if (element && element.innerText && element.innerText.trim()) {
              return element.innerText.trim();
            }
          }
        }
        return '';
      };
      
      // Special handling for About section with the new selectors
      const getAboutText = () => {
        const aboutSelectors = selectors.about;
        
        for (const selector of aboutSelectors) {
          const element = document.querySelector(selector);
          if (element && element.innerText && element.innerText.trim()) {
            return element.innerText.trim();
          }
        }
        
        // Last resort - look for any about section near #about element
        const aboutSection = document.querySelector('#about');
        if (aboutSection) {
          const nextSibling = aboutSection.nextElementSibling || aboutSection.parentElement?.nextElementSibling;
          if (nextSibling) {
            const spanElement = nextSibling.querySelector('span[aria-hidden="true"]');
            if (spanElement && spanElement.innerText && spanElement.innerText.trim()) {
              return spanElement.innerText.trim();
            }
          }
        }
        
        return '';
      };
      
      const aboutText = getAboutText();
      
      // Return only the fields you want
      return {
        name: getText(selectors.name) || 'Name not available',
        headline: getText(selectors.headline) || 'Headline not available', 
        location: getText(selectors.location) || 'Location not available',
        about: aboutText.replace(/^About/i, '').trim() || 'About not available',
        profileUrl: window.location.href,
        extractedAt: new Date().toISOString()
      };
    }, config.selectors);
    
    // Validate that we got meaningful data
    const hasValidData = profileData.name !== 'Name not available' || 
                        profileData.headline !== 'Headline not available' ||
                        profileData.location !== 'Location not available';
    
    if (!hasValidData) {
      throw new Error('Could not extract meaningful profile data - profile may be private or have restricted access');
    }
    
    console.log(`✅ Successfully extracted data for: ${profileData.name}`);
    return profileData;
    
  } catch (error) {
    console.error(`❌ Failed to extract profile data from ${profileUrl}:`, error.message);
    
    // Return partial data with error info instead of complete failure
    return { 
      name: 'Profile Access Limited', 
      headline: 'Could not access headline', 
      location: 'Location unavailable', 
      about: 'About section not accessible', 
      profileUrl: profileUrl, 
      error: error.message,
      extractedAt: new Date().toISOString(),
      status: 'partial_failure'
    };
  }
}

async function createExcelFile(profiles, filename) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('LinkedIn Profiles');
  worksheet.columns = config.worksheetColumns;
  worksheet.addRows(profiles);
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE6E6FA' }
  };
  const filePath = path.join(process.cwd(), 'downloads', filename);
  const downloadsDir = path.dirname(filePath);
  if (!fs.existsSync(downloadsDir)) {  fs.mkdirSync(downloadsDir, { recursive: true }); }
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// New endpoint to start session with manual login
app.post('/start-session', async (req, res) => {
  let browser = null;
  try {
    const {
      browser: browserName = 'chromium',
      sessionId = `session_${Date.now()}`
    } = req.body;

    browser = await browsers[browserName].launch({
      headless: false,
      slowMo: 100,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    const page = await context.newPage();

    // Store session
    activeSessions.set(sessionId, { browser, page, context });

    console.log('🚀 Starting browser session for manual login...');
    const loginSuccess = await openLinkedInForManualLogin(page, sessionId);
    
    if (!loginSuccess) {
      activeSessions.delete(sessionId);
      await browser.close();
      throw new Error('Manual login failed or timed out');
    }

    res.json({
      success: true,
      message: 'Session started and login successful',
      sessionId: sessionId
    });
    
  } catch (error) {
    console.error('❌ Session start error:', error);
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Modified scrape endpoint to use existing session with enhanced error handling
app.post('/scrape', async (req, res) => {
  try {
    const {
      sessionId,
      searchQuery,
      targetCount = 100,
      filename = `linkedin_profiles_${Date.now()}.xlsx`
    } = req.body;

    // Get existing session
    const session = activeSessions.get(sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired session. Please start a new session.'
      });
    }

    const { page } = session;

    const searchSuccess = await searchPeople(page, searchQuery);
    if (!searchSuccess) {
      throw new Error('Failed to perform search');
    }

    console.log(`📊 Collecting up to ${targetCount} profile URLs...`);
    const allProfileUrls = new Set();
    let pageNumber = 1;

    while (allProfileUrls.size < targetCount) {
      console.log(`📄 Processing search results page ${pageNumber}...`);
      const pageUrls = await extractProfileUrlsFromPage(page);
      pageUrls.forEach(url => allProfileUrls.add(url));
      console.log(`📈 Collected ${allProfileUrls.size} unique profile URLs so far`);

      if (allProfileUrls.size >= targetCount) {
        break;
      }

      const hasNextPage = await goToNextPage(page);
      if (!hasNextPage) {
        console.log('📄 No more pages available');
        break;
      }
      pageNumber++;
    }

    const profileUrlsArray = Array.from(allProfileUrls).slice(0, targetCount);
    console.log(`✅ Collected ${profileUrlsArray.length} profile URLs`);
    
    // Enhanced profile extraction with better error handling
    console.log('🔍 Extracting profile data...');
    const profiles = [];
    const failedProfiles = [];

    for (let i = 0; i < profileUrlsArray.length; i++) {
      const url = profileUrlsArray[i];
      console.log(`📊 Processing profile ${i + 1}/${profileUrlsArray.length}: ${url}`);
      
      try {
        const profileData = await extractProfileData(page, url);
        
        if (profileData.status === 'partial_failure') {
          failedProfiles.push(url);
          console.log(`⚠️ Partial data extracted for profile ${i + 1}`);
        } else {
          console.log(`✅ Successfully processed profile ${i + 1}`);
        }
        
        profiles.push(profileData);
        
        // Smart delay between profiles
        await smartDelay(page, 2000);
        
        // Add longer delay every 10 profiles to avoid rate limiting
        if ((i + 1) % 10 === 0) {
          console.log('⏸️ Taking a longer break to avoid rate limiting...');
          await page.waitForTimeout(10000);
        }
        
      } catch (error) {
        console.error(`❌ Critical error processing profile ${i + 1}:`, error.message);
        failedProfiles.push(url);
        
        // Add failed profile with error info
        profiles.push({
          name: 'Critical Error', 
          headline: 'Profile could not be processed', 
          location: 'Unknown', 
          about: 'Processing failed', 
          experience: 'Not extracted', 
          education: 'Not extracted', 
          skills: 'Not extracted', 
          connections: 'Unknown', 
          profileUrl: url, 
          error: error.message,
          extractedAt: new Date().toISOString(),
          status: 'critical_failure'
        });
        
        // Wait longer after errors
        await page.waitForTimeout(5000);
      }
    }

    console.log(`📊 Processing completed. Success: ${profiles.length - failedProfiles.length}, Failed: ${failedProfiles.length}`);

    console.log('📄 Creating Excel file...');
    const filePath = await createExcelFile(profiles, filename);
    console.log(`✅ Scraping completed! File saved: ${filePath}`);

    res.json({
      success: true,
      message: 'Scraping completed successfully',
      profilesCount: profiles.length,
      successCount: profiles.length - failedProfiles.length,
      failedCount: failedProfiles.length,
      filename: filename,
      downloadUrl: `/download/${filename}`,
      summary: {
        searchQuery,
        profilesScraped: profiles.length,
        successfulProfiles: profiles.length - failedProfiles.length,
        failedProfiles: failedProfiles.length,
        targetCount,
        timestamp: new Date().toISOString()
      }
    });  
  } catch (error) {
    console.error('❌ Scraping error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// New endpoint to close session
app.post('/close-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);
    
    if (session) {
      await session.browser.close();
      activeSessions.delete(sessionId);
      console.log(`🔒 Session ${sessionId} closed`);
    }

    res.json({
      success: true,
      message: 'Session closed successfully'
    });
  } catch (error) {
    console.error('❌ Error closing session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(process.cwd(), 'downloads', filename);
  if (!fs.existsSync(filePath)) {   return res.status(404).json({ error: 'File not found' }); }
  res.download(filePath, filename, (err) => {
    if (err) {  console.error('Download error:', err); }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Playwright API Server running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  // Close all active sessions
  for (const [sessionId, session] of activeSessions) {
    session.browser.close().catch(console.error);
  }
  process.exit(0);
});