class LinkedInScraper {
    constructor() {
        this.currentSessionId = null;
        this.isSessionActive = false;
        this.downloadUrl = null;
        this.progressInterval = null;
        
        this.initializeElements();
        this.bindEvents();
        this.updateUI();
        this.addLog('🚀 LinkedIn Scraper initialized successfully', 'info');
    }

    initializeElements() {
        // Status elements
        this.statusIndicator = document.getElementById('statusIndicator');
        this.statusMessage = document.getElementById('statusMessage');
        this.sessionDetails = document.getElementById('sessionDetails');
        
        // Login elements
        this.loginForm = document.getElementById('loginForm');
        this.connectedState = document.getElementById('connectedState');
        this.loginBtn = document.getElementById('loginBtn');
        this.logoutBtn = document.getElementById('logoutBtn');
        this.browserSelect = document.getElementById('browserSelect');
        
        // Form elements
        this.scrapeForm = document.getElementById('scrapeForm');
        this.scrapeBtn = document.getElementById('scrapeBtn');
        this.searchQuery = document.getElementById('searchQuery');
        this.targetCount = document.getElementById('targetCount');
        this.filename = document.getElementById('filename');
        
        // Progress elements
        this.progressSection = document.getElementById('progressSection');
        this.progressBar = document.getElementById('progressBar');
        this.progressText = document.getElementById('progressText');
        this.progressMessage = document.getElementById('progressMessage');
        
        // Results elements
        this.resultsSection = document.getElementById('resultsSection');
        this.resultsText = document.getElementById('resultsText');
        this.downloadBtn = document.getElementById('downloadBtn');
        
        // Stats elements
        this.profilesFound = document.getElementById('profilesFound');
        this.profilesScraped = document.getElementById('profilesScraped');
        
        // Logs
        this.logs = document.getElementById('logs');
    }

    bindEvents() {
        this.loginBtn.addEventListener('click', () => this.handleLogin());
        this.logoutBtn.addEventListener('click', () => this.handleLogout());
        this.scrapeForm.addEventListener('submit', (e) => this.startScraping(e));
        this.downloadBtn.addEventListener('click', () => this.downloadFile());
        
        // Auto-generate filename based on search query
        this.searchQuery.addEventListener('input', () => {
            if (this.searchQuery.value) {
                const sanitizedQuery = this.searchQuery.value.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                this.filename.value = `${sanitizedQuery}_profiles_${new Date().toISOString().split('T')[0]}.xlsx`;
            }
        });
    }

    updateUI() {
        if (this.isSessionActive) {
            // Connected state
            this.statusIndicator.className = 'status-indicator status-connected';
            this.statusMessage.innerHTML = '<span class="badge bg-success">✓ Connected to LinkedIn</span>';
            this.sessionDetails.textContent = `Active Session: ${this.currentSessionId}`;
            
            this.loginForm.classList.add('d-none');
            this.connectedState.classList.remove('d-none');
            this.loginBtn.classList.add('d-none');
            this.logoutBtn.classList.remove('d-none');
            
            this.scrapeBtn.disabled = false;
        } else {
            // Disconnected state
            this.statusIndicator.className = 'status-indicator status-disconnected';
            this.statusMessage.innerHTML = '<span class="badge bg-light text-dark">Ready to Connect</span>';
            this.sessionDetails.textContent = '';
            
            this.loginForm.classList.remove('d-none');
            this.connectedState.classList.add('d-none');
            this.loginBtn.classList.remove('d-none');
            this.logoutBtn.classList.add('d-none');
            
            this.scrapeBtn.disabled = true;
        }
    }

    updateConnectingState() {
        this.statusIndicator.className = 'status-indicator status-connecting';
        this.statusMessage.innerHTML = '<span class="badge bg-warning">🔄 Connecting...</span>';
        this.sessionDetails.textContent = 'Please complete login in the browser window';
    }

    addLog(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logClass = type === 'error' ? 'text-danger fw-bold' : 
                        type === 'success' ? 'text-success fw-bold' : 
                        type === 'warning' ? 'text-warning fw-bold' : 'text-info';
        
        this.logs.innerHTML += `<div class="${logClass}">[${timestamp}] ${message}</div>`;
        this.logs.scrollTop = this.logs.scrollHeight;
    }

    async handleLogin() {
        try {
            this.addLog('🔐 Initiating LinkedIn login process...', 'info');
            this.loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Opening Browser...';
            this.loginBtn.disabled = true;
            
            this.updateConnectingState();

            const response = await fetch('/start-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    browser: this.browserSelect.value
                })
            });

            const result = await response.json();

            if (result.success) {
                this.currentSessionId = result.sessionId;
                this.isSessionActive = true;
                this.addLog('✅ Successfully connected to LinkedIn!', 'success');
                this.addLog('🎯 Ready to start scraping profiles', 'info');
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            this.addLog(`❌ Login failed: ${error.message}`, 'error');
            this.isSessionActive = false;
        } finally {
            this.loginBtn.innerHTML = '<i class="fas fa-sign-in-alt me-2"></i>Login to LinkedIn';
            this.loginBtn.disabled = false;
            this.updateUI();
        }
    }

    async handleLogout() {
        try {
            this.addLog('🔒 Disconnecting from LinkedIn...', 'info');
            this.logoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Disconnecting...';
            
            if (this.currentSessionId) {
                await fetch('/close-session', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        sessionId: this.currentSessionId
                    })
                });
            }

            this.currentSessionId = null;
            this.isSessionActive = false;
            this.addLog('✅ Successfully disconnected from LinkedIn', 'success');
            this.resetStats();
        } catch (error) {
            this.addLog(`❌ Error during disconnect: ${error.message}`, 'error');
        } finally {
            this.logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt me-2"></i>Disconnect';
            this.updateUI();
        }
    }

    async startScraping(event) {
        event.preventDefault();
        
        if (!this.isSessionActive) {
            this.addLog('⚠️ Please login to LinkedIn first', 'warning');
            return;
        }

        try {
            this.scrapeBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Scraping in Progress...';
            this.scrapeBtn.disabled = true;
            this.progressSection.style.display = 'block';
            this.resultsSection.style.display = 'none';

            this.addLog(`🔍 Starting search for: "${this.searchQuery.value}"`, 'info');
            this.addLog(`📊 Target: ${this.targetCount.value} profiles`, 'info');
            
            this.simulateProgress();

            const response = await fetch('/scrape', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId: this.currentSessionId,
                    searchQuery: this.searchQuery.value,
                    targetCount: parseInt(this.targetCount.value),
                    filename: this.filename.value
                })
            });

            const result = await response.json();

            if (result.success) {
                this.downloadUrl = result.downloadUrl;
                this.showResults(result);
                this.addLog(`🎉 Scraping completed! Found ${result.profilesCount} profiles`, 'success');
                this.profilesScraped.textContent = result.profilesCount;
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            this.addLog(`❌ Scraping failed: ${error.message}`, 'error');
        } finally {
            this.scrapeBtn.innerHTML = '<i class="fas fa-rocket me-2"></i>Start Scraping Process';
            this.scrapeBtn.disabled = false;
            this.clearProgressInterval();
        }
    }

    simulateProgress() {
        let progress = 0;
        const messages = [
            'Searching LinkedIn profiles...',
            'Extracting profile data...',
            'Processing information...',
            'Generating Excel file...',
            'Finalizing results...'
        ];
        let messageIndex = 0;

        this.progressInterval = setInterval(() => {
            progress += Math.random() * 10 + 5;
            
            if (progress >= 95) {
                progress = 95;
                this.progressMessage.textContent = 'Almost done...';
            } else if (messageIndex < messages.length) {
                this.progressMessage.textContent = messages[Math.floor(progress / 20)];
            }
            
            this.updateProgress(progress);
            
            if (progress >= 95) {
                this.clearProgressInterval();
            }
        }, 1500);
    }

    clearProgressInterval() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
    }

    updateProgress(percentage) {
        this.progressBar.style.width = `${percentage}%`;
        this.progressText.textContent = `${Math.round(percentage)}%`;
        this.profilesFound.textContent = Math.round(percentage * 2); // Simulate found profiles
    }

    showResults(result) {
        this.updateProgress(100);
        this.progressMessage.textContent = 'Completed successfully!';
        this.progressSection.style.display = 'none';
        this.resultsSection.style.display = 'block';
        
        this.resultsText.innerHTML = `
            <div class="row">
                <div class="col-md-6">
                    <strong>🔍 Search Query:</strong> ${result.summary.searchQuery}<br>
                    <strong>📊 Profiles Found:</strong> ${result.profilesCount}<br>
                </div>
                <div class="col-md-6">
                    <strong>📁 Filename:</strong> ${result.filename}<br>
                    <strong>⏰ Completed:</strong> ${new Date().toLocaleTimeString()}<br>
                </div>
            </div>
        `;
    }

    downloadFile() {
        if (this.downloadUrl) {
            window.open(this.downloadUrl, '_blank');
            this.addLog('📥 Download started successfully', 'success');
        }
    }

    resetStats() {
        this.profilesFound.textContent = '0';
        this.profilesScraped.textContent = '0';
        this.progressSection.style.display = 'none';
        this.resultsSection.style.display = 'none';
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new LinkedInScraper();
});