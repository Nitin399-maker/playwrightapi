import express from 'express';
import { chromium, firefox, webkit } from 'playwright';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
const app = express();
const PORT = 3000;
app.use(express.json());
const browsers = {chromium, firefox, webkit };
async function loginToLinkedIn(page, email, password) {
  try {
    await page.goto('https://www.linkedin.com/login');
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.fill('#username', email);
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/feed/**', { timeout: 30000 }); 
    return true;
  } catch (error) {
    console.error('❌ Login failed:', error.message);
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
        .map(link => link.href.split('?')[0]) // remove query params like ?miniProfileUrn
        .filter(url => {
          const pathname = new URL(url).pathname;
          
          // Must match /in/username or /in/username/
          const publicProfilePattern = /^\/in\/[a-zA-Z0-9\-]+\/?$/;

          return (
            publicProfilePattern.test(pathname) &&             // clean public slug
            !url.includes('miniProfileUrn') &&                // exclude mutuals with query
            !pathname.includes('ACoA')                        // exclude URN-style IDs
          );
        })
        .filter((url, index, self) => self.indexOf(url) === index); // remove duplicates
    });

    return profileUrls;
  } catch (error) {
    console.error('❌ Failed to extract profile URLs:', error.message);
    return [];
  }
}


async function goToNextPage(page) {
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    try {
      await page.waitForSelector('.artdeco-pagination', { timeout: 5000 });
    } catch {
      return false;
    }

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

        const isClickable = !buttonState.disabled &&
                            buttonState.ariaDisabled !== 'true' &&
                            buttonState.buttonText === 'Next';
        if (!isClickable) continue;

        const currentUrl = page.url();
        const currentPageMatch = currentUrl.match(/&page=(\d+)/);
        const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : 1;

        await nextButton.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);

        try {
          await nextButton.click();
        } catch {
          await nextButton.click({ force: true });
        }

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
  } catch {
    return false;
  }
}


async function extractProfileData(page, profileUrl) {
  try {
    await page.goto(profileUrl);
    await page.waitForTimeout(3000);
    const nameSelectors = ['h1', '.text-heading-xlarge', '.pv-text-details__left-panel h1'];
    let nameLoaded = false;
    for (const selector of nameSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        nameLoaded = true;
        break;
      } 
      catch (e) { continue; }
    }
    if (!nameLoaded) { throw new Error('Profile did not load properly'); }
    const profileData = await page.evaluate(() => {
      const getText = (selectors) => {
        if (typeof selectors === 'string') {   selectors = [selectors];  }
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element && element.innerText) {
            return element.innerText.trim();
          }
        }
        return '';
      };
      const getMultipleTexts = (selectors) => {
        if (typeof selectors === 'string') {   selectors = [selectors];  }
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            return Array.from(elements)
              .map(el => el.innerText.trim()).filter(text => text.length > 0).join(' | ');
          }
        }
        return '';
      };
      
      return {
        name: getText(['h1', '.text-heading-xlarge', '.pv-text-details__left-panel h1', '.pv-top-card--list li:first-child']),
        headline: getText(['.text-body-medium.break-words', '.pv-text-details__left-panel .text-body-medium', '.pv-top-card--list li:nth-child(2)', '.top-card-layout__headline']),
        location: getText(['.text-body-small.inline.t-black--light.break-words', '.pv-text-details__left-panel .text-body-small', '.pv-top-card--list-bullet li', '.top-card-layout__first-subline']),
        about: getText(['#about ~ div .pv-shared-text-with-see-more', '.pv-about-section .pv-about__summary-text', '[data-section="summary"] .pv-about__summary-text']).replace('About', '').trim(),
        experience: getMultipleTexts(['#experience ~ div .t-bold', '.pv-profile-section.experience .pv-entity__summary-info h3', '[data-section="experience"] .pv-entity__summary-info h3']),
        education: getMultipleTexts(['#education ~ div .t-bold', '.pv-profile-section.education .pv-entity__summary-info h3', '[data-section="education"] .pv-entity__summary-info h3']),
        skills: getMultipleTexts(['#skills ~ div .hoverable-link-text', '.pv-skill-category-entity__name', '[data-section="skills"] .pv-skill-category-entity__name']),
        connections: getText(['.t-black--light.t-normal', '.pv-top-card--list-bullet', '.top-card-layout__first-subline']),
        profileUrl: window.location.href
      };
    }); 
    console.log(`✅ Extracted data for: ${profileData.name || 'Unknown'}`);
    return profileData;
  } catch (error) {
    console.error(`❌ Failed to extract profile data from ${profileUrl}:`, error.message);
    return { name: 'N/A', headline: 'N/A', location: 'N/A', about: 'N/A', experience: 'N/A', education: 'N/A', skills: 'N/A', connections: 'N/A', profileUrl: profileUrl, error: error.message };
  }
}
async function createExcelFile(profiles, filename) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('LinkedIn Profiles');
  worksheet.columns = [
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Headline', key: 'headline', width: 50 },
    { header: 'Location', key: 'location', width: 30 },
    { header: 'About', key: 'about', width: 80 },
    { header: 'Experience', key: 'experience', width: 80 },
    { header: 'Education', key: 'education', width: 50 },
    { header: 'Skills', key: 'skills', width: 60 },
    { header: 'Connections', key: 'connections', width: 20 },
    { header: 'Profile URL', key: 'profileUrl', width: 50 },
    { header: 'Error', key: 'error', width: 30 }
  ];
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
app.post('/scrape', async (req, res) => {
  let browser = null;
  try {
    const {
      browser: browserName = 'chromium',
      email,
      password,
      searchQuery,
      targetCount = 100,
      filename = `linkedin_profiles_${Date.now()}.xlsx`
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
    console.log('🚀 Starting LinkedIn scraping process...');
    const loginSuccess = await loginToLinkedIn(page, email, password);
    if (!loginSuccess) {  throw new Error('Failed to login to LinkedIn');  }

    const searchSuccess = await searchPeople(page, searchQuery);
    if (!searchSuccess) {  throw new Error('Failed to perform search'); }
    console.log(`📊 Collecting up to ${targetCount} profile URLs...`);
    const allProfileUrls = new Set();
    let pageNumber = 1;
    while (allProfileUrls.size < targetCount) {
      console.log(`📄 Processing search results page ${pageNumber}...`);
      const pageUrls = await extractProfileUrlsFromPage(page);
      pageUrls.forEach(url => allProfileUrls.add(url));
      console.log(`📈 Collected ${allProfileUrls.size} unique profile URLs so far`);
      if (allProfileUrls.size >= targetCount) {  break;  }
      const hasNextPage = await goToNextPage(page);
      if (!hasNextPage) {  console.log('📄 No more pages available');  break;  }
      pageNumber++;
    }
    const profileUrlsArray = Array.from(allProfileUrls).slice(0, targetCount);
    console.log(`✅ Collected ${profileUrlsArray.length} profile URLs`);
    
    console.log('🔍 Extracting profile data...');
    const profiles = [];
    for (let i = 0; i < profileUrlsArray.length; i++) {
      const url = profileUrlsArray[i];
      console.log(`📊 Processing profile ${i + 1}/${profileUrlsArray.length}: ${url}`);
      const profileData = await extractProfileData(page, url);
      profiles.push(profileData);
      await page.waitForTimeout(2000);
    }
    console.log('📄 Creating Excel file...');
    const filePath = await createExcelFile(profiles, filename);
    console.log(`✅ Scraping completed! File saved: ${filePath}`);
    res.json({
      success: true,
      message: 'Scraping completed successfully',
      profilesCount: profiles.length,
      filename: filename,
      downloadUrl: `/download/${filename}`,
      summary: {
        searchQuery,
        profilesScraped: profiles.length,
        targetCount,
        timestamp: new Date().toISOString()
      }
    });  
  } catch (error) {
    console.error('❌ Scraping error:', error);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
  }
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
process.on('SIGINT', () => { console.log('\n👋 Shutting down server...'); process.exit(0);});