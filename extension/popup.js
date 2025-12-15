// popup.js - Enhanced version with Firebase dashboard integration

document.addEventListener('DOMContentLoaded', init);

let cachedApiKey = '';

const maskApiKey = (value) => {
  if (!value) return '';
  if (value.length <= 4) {
    return '••••';
  }
  return `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
};

function showApiKeySummary(keyValue) {
  const summary = document.getElementById('api-key-summary');
  cachedApiKey = keyValue || '';
  if (!summary) return;
  if (keyValue) {
    summary.innerHTML = `<strong>API key stored</strong><div>${maskApiKey(keyValue)}</div>`;
    summary.classList.remove('hidden');
  } else {
    summary.classList.add('hidden');
    summary.textContent = '';
  }
}

function setConfigCollapsed(collapsed) {
  const configContent = document.getElementById('config-content');
  const configToggle = document.getElementById('config-toggle');
  const apiKeyEl = document.getElementById('apiKey');
  if (!configContent || !configToggle) return;
  if (collapsed) {
    configContent.classList.add('collapsed');
    configToggle.textContent = 'Edit secure settings';
    if (apiKeyEl) {
      apiKeyEl.value = '';
    }
  } else {
    configContent.classList.remove('collapsed');
    configToggle.textContent = 'Hide secure settings';
    if (apiKeyEl) {
      apiKeyEl.value = cachedApiKey;
    }
  }
}

async function init() {
  // Load saved settings
  const stored = await chrome.storage.local.get([
    'or_api_key', 
    'or_endpoint', 
    'or_model', 
    'user_threshold',
    'firebaseEnabled',
    'userEmail'
  ]);
  
  // Populate form fields
  const apiKeyEl = document.getElementById('apiKey');
  const endpointEl = document.getElementById('endpoint');
  const modelEl = document.getElementById('model');
  const thresholdEl = document.getElementById('threshold');
  const firebaseToggle = document.getElementById('firebase-toggle');
  const userEmailEl = document.getElementById('user-email');
  const emailGroup = document.getElementById('email-group');
  const configToggle = document.getElementById('config-toggle');
  if (configToggle) {
    configToggle.addEventListener('click', () => {
      const configContent = document.getElementById('config-content');
      const collapsed = configContent?.classList.contains('collapsed');
      setConfigCollapsed(!collapsed);
    });
  }
  
  if (stored.or_api_key) {
    apiKeyEl.value = stored.or_api_key;
    showStatus('key-status', 'API key configured', 'success');
  }
  endpointEl.value = stored.or_endpoint || 'https://openrouter.ai/api/v1/chat/completions';
  modelEl.value = stored.or_model || 'meta-llama/llama-3.2-3b-instruct:free';
  thresholdEl.value = stored.user_threshold || 50;
  
  // Firebase settings
  if (firebaseToggle) {
    firebaseToggle.checked = stored.firebaseEnabled || false;
    if (emailGroup) {
      emailGroup.classList.toggle('hidden', !firebaseToggle.checked);
    }
  }
  
  if (userEmailEl) {
    userEmailEl.value = stored.userEmail || '';
  }
  
  showApiKeySummary(stored.or_api_key);
  setConfigCollapsed(Boolean(stored.or_api_key));
  
  // Load last analysis result if available
  loadLastResult();
  
  // Event listeners
  document.getElementById('save').addEventListener('click', saveSettings);
  document.getElementById('clear').addEventListener('click', clearApiKey);
  document.getElementById('scan-btn').addEventListener('click', scanEmail);
  
  if (firebaseToggle) {
    firebaseToggle.addEventListener('change', (e) => {
      const checked = e.target.checked;
      if (emailGroup) {
        emailGroup.classList.toggle('hidden', !checked);
      }
      if (checked && userEmailEl && !userEmailEl.value) {
        showStatus('firebase-status', 'Please enter your email address (same one you used to login on the website)', 'info');
      }
    });
  } else {
    console.error('Firebase toggle not found!'); // Debug log
  }
  
  // Check if we're on a supported email page
  checkEmailPage();
}

async function saveSettings() {
  const apiKeyEl = document.getElementById('apiKey');
  const endpointEl = document.getElementById('endpoint');
  const modelEl = document.getElementById('model');
  const thresholdEl = document.getElementById('threshold');
  const firebaseToggle = document.getElementById('firebase-toggle');
  const userEmailEl = document.getElementById('user-email');
  
  const k = apiKeyEl.value.trim();
  const e = endpointEl.value.trim();
  const m = modelEl.value.trim();
  const t = Math.max(1, Math.min(100, parseInt(thresholdEl.value, 10) || 50));
  const firebaseEnabled = firebaseToggle.checked;
  const userEmail = userEmailEl.value.trim();
  
  if (!k) {
    showStatus('key-status', 'Please enter an API key', 'error');
    return;
  }
  
  if (!k.startsWith('sk-or-')) {
    showStatus('key-status', 'Invalid API key format (should start with sk-or-)', 'error');
    return;
  }
  
  if (firebaseEnabled && !userEmail) {
    showStatus('firebase-status', 'Please enter your email for dashboard integration', 'error');
    return;
  }
  
  if (firebaseEnabled && !isValidEmail(userEmail)) {
    showStatus('firebase-status', 'Please enter a valid email address', 'error');
    return;
  }
  
  await chrome.storage.local.set({ 
    or_api_key: k, 
    or_endpoint: e, 
    or_model: m, 
    user_threshold: t,
    firebaseEnabled: firebaseEnabled,
    userEmail: userEmail
  });
  
  showStatus('key-status', '✓ Settings saved successfully', 'success');
  showApiKeySummary(k);
  setConfigCollapsed(true);
  
  if (firebaseEnabled) {
    showStatus('firebase-status', '✓ Dashboard integration enabled', 'success');
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function clearApiKey() {
  await chrome.storage.local.remove(['or_api_key']);
  document.getElementById('apiKey').value = '';
  showStatus('key-status', 'API key cleared', 'info');
  showApiKeySummary(null);
  setConfigCollapsed(false);
}

async function scanEmail() {
  const { or_api_key } = await chrome.storage.local.get('or_api_key');
  
  if (!or_api_key) {
    showStatus('scan-status', 'Please configure your API key first', 'error');
    return;
  }
  
  const scanBtn = document.getElementById('scan-btn');
  scanBtn.disabled = true;
  scanBtn.innerHTML = '<span class="btn-icon">⏳</span> Scanning...';
  
  showStatus('scan-status', 'Analyzing email...', 'info');
  
  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('mail.google.com') && 
        !tab.url.includes('outlook.live.com') && 
        !tab.url.includes('outlook.office.com')) {
      throw new Error('Please open Gmail or Outlook to scan emails');
    }
    
    // Send message to content script to scan
    chrome.tabs.sendMessage(tab.id, { action: 'scanFromPopup' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('scan-status', `Error: ${chrome.runtime.lastError.message}`, 'error');
        scanBtn.disabled = false;
        scanBtn.innerHTML = '<span class="btn-icon">🔍</span> Scan Current Email';
        return;
      }
      
      if (response && response.success) {
        // Poll for result
        pollForResult().then(() => {
          scanBtn.disabled = false;
          scanBtn.innerHTML = '<span class="btn-icon">🔍</span> Scan Current Email';
        });
      } else {
        showStatus('scan-status', `Error: ${response?.error || 'Scan failed'}`, 'error');
        scanBtn.disabled = false;
        scanBtn.innerHTML = '<span class="btn-icon">🔍</span> Scan Current Email';
      }
    });
    
    return; // Exit here since we handle the button state in callback
  } catch (error) {
    console.error('Scan error:', error);
    showStatus('scan-status', `Error: ${error.message}`, 'error');
    scanBtn.disabled = false;
    scanBtn.innerHTML = '<span class="btn-icon">🔍</span> Scan Current Email';
  }
}

async function pollForResult() {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 60; // Increased from 30 to 60 (60 seconds)
    
    const interval = setInterval(async () => {
      attempts++;
      
      // Get all analysis results
      const storage = await chrome.storage.local.get(null);
      const analysisKeys = Object.keys(storage).filter(k => k.startsWith('analysis_'));
      
      if (analysisKeys.length > 0) {
        // Get most recent analysis
        const latestKey = analysisKeys.sort().pop();
        const result = storage[latestKey];
        
        displayResult(result);
        showStatus('scan-status', 'Analysis complete!', 'success');
        
        // Check if data was sent to dashboard
        const { firebaseEnabled } = await chrome.storage.local.get('firebaseEnabled');
        if (firebaseEnabled) {
          showStatus('firebase-status', '✓ Results sent to dashboard', 'success');
        }
        
        clearInterval(interval);
        resolve();
      } else if (attempts >= maxAttempts) {
        showStatus('scan-status', 'Analysis timed out. Please try again.', 'error');
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });
}

async function loadLastResult() {
  const storage = await chrome.storage.local.get(null);
  const analysisKeys = Object.keys(storage).filter(k => k.startsWith('analysis_'));
  
  if (analysisKeys.length > 0) {
    const latestKey = analysisKeys.sort().pop();
    const result = storage[latestKey];
    displayResult(result);
  }
}

function displayResult(result) {
  const resultsSection = document.getElementById('results-section');
  const resultCard = document.getElementById('result-card');
  const resultHeader = resultCard.querySelector('.result-header');
  const resultIcon = document.getElementById('result-icon');
  const resultTitle = document.getElementById('result-title');
  const confidenceFill = document.getElementById('confidence-fill');
  const confidenceText = document.getElementById('confidence-text');
  const recommendationText = document.getElementById('recommendation-text');
  const indicatorsList = document.getElementById('indicators-list');
  const indicatorsSection = document.getElementById('indicators-section');
  
  // Show results section
  resultsSection.style.display = 'block';
  
  // Set header style
  resultHeader.className = `result-header ${result.isPhishing ? 'danger' : 'safe'}`;
  resultIcon.textContent = result.isPhishing ? '⚠️' : '✅';
  resultTitle.textContent = result.isPhishing ? 'Potential Phishing Detected' : 'Email Appears Safe';
  
  // Set confidence bar
  const confidence = result.confidence || 0;
  confidenceFill.style.width = `${confidence}%`;
  
  // Color code confidence
  if (confidence >= 80) {
    confidenceFill.style.background = result.isPhishing ? '#ef4444' : '#10b981';
  } else if (confidence >= 50) {
    confidenceFill.style.background = '#f59e0b';
  } else {
    confidenceFill.style.background = '#6b7280';
  }
  
  confidenceText.textContent = `${confidence}% confidence`;
  
  // Set recommendation
  recommendationText.textContent = result.recommendation || 'No specific recommendation';
  
  // Set indicators
  if (result.indicators && result.indicators.length > 0) {
    indicatorsSection.style.display = 'block';
    indicatorsList.innerHTML = result.indicators
      .map(indicator => `<li>${indicator}</li>`)
      .join('');
  } else {
    indicatorsSection.style.display = 'none';
  }
  
  // Update stats
  const timestamp = new Date(result.timestamp).toLocaleString();
  document.getElementById('stats-text').textContent = `Last scan: ${timestamp}`;
}

function showStatus(elementId, message, type) {
  const statusEl = document.getElementById(elementId);
  if (!statusEl) return;
  
  statusEl.textContent = message;
  statusEl.className = `status-message show ${type}`;
  
  setTimeout(() => {
    statusEl.classList.remove('show');
  }, 5000);
}

async function checkEmailPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isEmailPage = tab.url.includes('mail.google.com') || 
                        tab.url.includes('outlook.live.com') || 
                        tab.url.includes('outlook.office.com');
    
    if (!isEmailPage) {
      showStatus('scan-status', 'Open Gmail or Outlook to scan emails', 'info');
    }
  } catch (error) {
    console.error('Error checking page:', error);
  }
}
