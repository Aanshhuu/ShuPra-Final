// popup.js - Enhanced version with Firebase dashboard integration

document.addEventListener('DOMContentLoaded', init);

const FIREBASE_API_KEY = 'AIzaSyBjtmGy5tF6fGE3aDjeiiDLp9ssX0K5SOU';
const EMBEDDED_OR_KEY = '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';
const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const AUTH_STORAGE_KEY = 'authUser';
const USER_EMAIL_MAP_KEY = 'dashboardEmails';
let currentAuthUser = null;
let appListenersBound = false;

async function init() {
  bindAuthUI();
  const authUser = await getAuthUser();
  if (authUser) {
    await unlockApp(authUser);
  } else {
    lockApp();
  }
}

const maskApiKey = (value) => {
  if (!value) return '';
  if (value.length <= 4) {
    return '••••';
  }
  return `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
};

function updateManagedKeyChip() {
  const summary = document.getElementById('api-key-summary');
  if (!summary) return;
  const masked = maskApiKey(EMBEDDED_OR_KEY);
  summary.innerHTML = `<strong>Managed key active</strong><div>${masked}</div>`;
}

async function ensureManagedKeyStored() {
  const { or_api_key } = await chrome.storage.local.get('or_api_key');
  if (or_api_key !== EMBEDDED_OR_KEY) {
    await chrome.storage.local.set({ or_api_key: EMBEDDED_OR_KEY });
  }
}

async function saveDashboardEmailPreference(ownerEmail, emailValue) {
  if (!ownerEmail) return;
  const data = await chrome.storage.local.get(USER_EMAIL_MAP_KEY);
  const map = data[USER_EMAIL_MAP_KEY] || {};
  map[ownerEmail] = emailValue;
  await chrome.storage.local.set({
    [USER_EMAIL_MAP_KEY]: map,
    userEmail: emailValue
  });
}

function bindAuthUI() {
  const authForm = document.getElementById('auth-form');
  const authButton = document.getElementById('auth-login');
  if (authForm) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleAuthLogin();
    });
  }
  if (authButton) {
    authButton.addEventListener('click', (e) => {
      e.preventDefault();
      handleAuthLogin();
    });
  }
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
}

function lockApp() {
  const authWall = document.getElementById('auth-wall');
  const appContainer = document.getElementById('app-container');
  if (authWall) authWall.classList.remove('hidden');
  if (appContainer) appContainer.classList.add('hidden');
}

async function unlockApp(authUser) {
  currentAuthUser = authUser;
  await ensureManagedKeyStored();
  updateManagedKeyChip();
  const authWall = document.getElementById('auth-wall');
  const appContainer = document.getElementById('app-container');
  const emailTarget = document.getElementById('auth-user-email');
  if (authWall) authWall.classList.add('hidden');
  if (appContainer) appContainer.classList.remove('hidden');
  if (emailTarget) emailTarget.textContent = authUser.email || 'Unknown user';

  if (!appListenersBound) {
    bindAppListeners();
    appListenersBound = true;
  }

  await loadAppState();
}

async function getAuthUser() {
  const data = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  const user = data[AUTH_STORAGE_KEY];
  if (!user) return null;
  if (user.expiresAt && Date.now() > user.expiresAt) {
    await chrome.storage.local.remove(AUTH_STORAGE_KEY);
    return null;
  }
  return user;
}

async function handleAuthLogin() {
  const emailEl = document.getElementById('auth-email');
  const passwordEl = document.getElementById('auth-password');
  if (!emailEl || !passwordEl) return;
  const email = emailEl.value.trim();
  const password = passwordEl.value.trim();

  if (!isValidEmail(email)) {
    showStatus('auth-status', 'Enter the email you used on the dashboard', 'error');
    return;
  }
  if (!password) {
    showStatus('auth-status', 'Password is required', 'error');
    return;
  }

  try {
    showStatus('auth-status', 'Signing in...', 'info');
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Authentication failed');
    }

    const expiresInMs = (parseInt(data.expiresIn, 10) || 3600) * 1000;
    const authRecord = {
      email: data.email,
      localId: data.localId,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + expiresInMs
    };
    await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: authRecord });
    await saveDashboardEmailPreference(data.email, data.email);
    showStatus('auth-status', '✓ Login successful', 'success');
    await unlockApp(authRecord);
  } catch (error) {
    console.error('Auth error:', error);
    showStatus('auth-status', error.message || 'Unable to sign in', 'error');
  }
}

async function handleLogout() {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
  currentAuthUser = null;
  lockApp();
  showStatus('auth-status', 'You have been logged out.', 'info');
}

function bindAppListeners() {
  document.getElementById('scan-btn')?.addEventListener('click', scanEmail);
  const firebaseToggle = document.getElementById('firebase-toggle');
  const userEmailEl = document.getElementById('user-email');
  const emailGroup = document.getElementById('email-group');
  if (firebaseToggle) {
    firebaseToggle.addEventListener('change', (e) => {
      const checked = e.target.checked;
      if (emailGroup) {
        emailGroup.classList.toggle('hidden', !checked);
      }
      if (checked && userEmailEl && !userEmailEl.value) {
        userEmailEl.value = currentAuthUser?.email || '';
        showStatus('firebase-status', 'Please confirm the email for dashboard sync', 'info');
      }
      const emailToSave = userEmailEl?.value || currentAuthUser?.email || '';
      persistIntegrationSettings(checked, emailToSave);
    });
  }
  if (userEmailEl) {
    userEmailEl.addEventListener('blur', () => {
      const firebaseEnabled = firebaseToggle?.checked ?? false;
      if (!firebaseEnabled) return;
      persistIntegrationSettings(true, userEmailEl.value || currentAuthUser?.email || '');
    });
  }
}

async function loadAppState() {
  // Load saved settings
  const stored = await chrome.storage.local.get([
    'or_api_key', 
    'or_endpoint', 
    'or_model', 
    'user_threshold',
    'firebaseEnabled',
    'userEmail',
    USER_EMAIL_MAP_KEY
  ]);
  
  await ensureManagedKeyStored();
  updateManagedKeyChip();
  
  // Firebase settings
  const firebaseToggle = document.getElementById('firebase-toggle');
  const userEmailEl = document.getElementById('user-email');
  const emailGroup = document.getElementById('email-group');
  if (firebaseToggle) {
    firebaseToggle.checked = stored.firebaseEnabled || false;
    if (emailGroup) {
      emailGroup.classList.toggle('hidden', !firebaseToggle.checked);
    }
  }
  
  if (userEmailEl) {
    const emailMap = stored[USER_EMAIL_MAP_KEY] || {};
    const preferred = emailMap[currentAuthUser?.email] || stored.userEmail || currentAuthUser?.email || '';
    userEmailEl.value = preferred;
  }
  // Check if we're on a supported email page
  checkEmailPage();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function persistIntegrationSettings(firebaseEnabled, userEmail) {
  const cleanEmail = (userEmail || '').trim();
  if (firebaseEnabled) {
    if (!cleanEmail) {
      showStatus('firebase-status', 'Enter your dashboard email to sync events.', 'error');
      return false;
    }
    if (!isValidEmail(cleanEmail)) {
      showStatus('firebase-status', 'Please enter a valid email address', 'error');
      return false;
    }
  }

  await chrome.storage.local.set({
    or_api_key: EMBEDDED_OR_KEY,
    or_endpoint: DEFAULT_ENDPOINT,
    or_model: 'meta-llama/llama-3.2-3b-instruct:free',
    user_threshold: 50,
    firebaseEnabled,
    userEmail: cleanEmail
  });
  if (firebaseEnabled && (currentAuthUser?.email || cleanEmail)) {
    await saveDashboardEmailPreference(currentAuthUser?.email || cleanEmail, cleanEmail || currentAuthUser?.email || '');
  }
  updateManagedKeyChip();
  if (firebaseEnabled) {
    showStatus('firebase-status', '✓ Dashboard integration enabled', 'success');
  } else {
    showStatus('firebase-status', 'Dashboard sync disabled', 'info');
  }
  return true;
}

async function scanEmail() {
  if (!currentAuthUser) {
    showStatus('scan-status', 'Please login before scanning emails.', 'error');
    return;
  }
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
  const linkHealthSection = document.getElementById('link-health-section');
  const linkHealthSummary = document.getElementById('link-health-summary');
  const linkHealthList = document.getElementById('link-health-list');
  
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
  
  if (linkHealthSection && linkHealthSummary && linkHealthList) {
    renderLinkHealthInPopup(result.linkHealth, linkHealthSection, linkHealthSummary, linkHealthList);
  }
  
  // Set indicators
  if (result.indicators && result.indicators.length > 0) {
    indicatorsSection.style.display = 'block';
    indicatorsList.innerHTML = result.indicators
      .map(indicator => `<li>${indicator}</li>`)
      .join('');
  } else {
    indicatorsSection.style.display = 'none';
  }
  
}

function renderLinkHealthInPopup(linkHealth, sectionEl, summaryEl, listEl) {
  listEl.innerHTML = '';
  if (!linkHealth || !Array.isArray(linkHealth.entries) || linkHealth.entries.length === 0) {
    sectionEl.style.display = 'none';
    summaryEl.textContent = '';
    return;
  }

  sectionEl.style.display = 'block';
  summaryEl.textContent = `Checked ${linkHealth.checkedLinks} of ${linkHealth.totalLinks} link(s)`;

  linkHealth.entries.forEach(entry => {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.textContent = entry.ok ? '🟢' : '⚠️';
    const host = document.createElement('span');
    host.textContent = entry.hostname || entry.url;
    host.classList.add('link-host');
    li.appendChild(icon);
    li.appendChild(host);

    const details = [];
    if (entry.statusCode) {
      details.push(`HTTP ${entry.statusCode}`);
    }
    if (entry.message && (!entry.ok || details.length === 0)) {
      details.push(entry.message);
    }
    if (details.length) {
      const detail = document.createElement('span');
      detail.textContent = ` — ${details.join(' | ')}`;
      li.appendChild(detail);
    }

    listEl.appendChild(li);
  });
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
