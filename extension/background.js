// background.js - Handles API calls and Firebase integration

const EMBEDDED_OR_KEY = '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';

// Import Firebase (using dynamic import since we can't use ES modules in service worker directly)
let firebaseInitialized = false;
let db = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'analyzeEmail') {
        // Call the main analysis router function
        analyzeEmail(request.emailData)
            .then(result => sendResponse({ success: true, result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep channel open for async response
    }
    
    if (request.action === 'showNotification') {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: request.title,
            message: request.message
        });
    }
});

async function requireAuthUser() {
    const { authUser } = await chrome.storage.local.get('authUser');
    if (!authUser || (authUser.expiresAt && Date.now() > authUser.expiresAt)) {
        throw new Error('Please login via the extension popup to enable scanning.');
    }
    return authUser;
}

// Main analysis router function
async function analyzeEmail(emailData) {
    const authUser = await requireAuthUser();
    // Get settings from storage
    const settings = await chrome.storage.local.get([
        'or_api_key',
        'or_endpoint', 
        'or_model',
        'user_threshold',
        'firebaseEnabled',
        'userEmail'
    ]);
    
    if (!settings.userEmail && authUser?.email) {
        settings.userEmail = authUser.email;
    }
    if (!settings.or_api_key) {
        settings.or_api_key = EMBEDDED_OR_KEY;
    }

    // Check for API key. If missing, use the local fallback.
    if (!settings.or_api_key) {
        console.warn("No OpenRouter API key configured. Running local, basic scan.");
        const result = runLocalBasicScan(emailData);
        
        // Send to Firebase if enabled
        if (settings.firebaseEnabled && settings.userEmail) {
            await sendToFirebase(emailData, result, settings.userEmail);
        }
        
        return result;
    }

    // Attempt to run the high-quality API scan
    try {
        const result = await analyzeEmailWithOpenRouter(emailData, settings);
        
        // Send to Firebase if enabled
        if (settings.firebaseEnabled && settings.userEmail) {
            await sendToFirebase(emailData, result, settings.userEmail);
        }
        
        return result;
    } catch (error) {
        // If the API call fails (e.g., Rate Limit Exceeded, 404, or network error)
        console.error('OpenRouter API failed. Falling back to local scan.', error);
        const result = runLocalBasicScan(emailData, true); // Pass true to indicate fallback mode
        
        // Send to Firebase if enabled
        if (settings.firebaseEnabled && settings.userEmail) {
            await sendToFirebase(emailData, result, settings.userEmail);
        }
        
        return result;
    }
}

// Send data to Firebase
async function sendToFirebase(emailData, result, userEmail) {
    try {
        const eventData = {
            timestamp: Date.now(),
            user: userEmail,
            from: emailData.from || 'Unknown',
            subject: emailData.subject || 'No Subject',
            score: result.confidence || 0,
            isPhishing: result.isPhishing || false,
            reasons: result.indicators || [],
            recommendation: result.recommendation || ''
        };
        
        // Use fetch to send to Firestore REST API
        const projectId = 'shupraprotects'; // Your Firebase project ID
        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/emailEvents`;
        
        // Convert eventData to Firestore format
        const firestoreData = {
            fields: {
                timestamp: { integerValue: String(eventData.timestamp) },
                user: { stringValue: eventData.user },
                from: { stringValue: eventData.from },
                subject: { stringValue: eventData.subject },
                score: { integerValue: String(eventData.score) },
                isPhishing: { booleanValue: eventData.isPhishing },
                reasons: { arrayValue: { values: eventData.reasons.map(r => ({ stringValue: r })) } },
                recommendation: { stringValue: eventData.recommendation }
            }
        };
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(firestoreData)
        });
        
        if (response.ok) {
            console.log('✓ Data sent to Firebase dashboard');
        } else {
            const error = await response.text();
            console.error('Firebase error:', error);
        }
    } catch (error) {
        console.error('Error sending to Firebase:', error);
        // Don't throw - Firebase is optional
    }
}

const SUSPICIOUS_TLDS = [
    'ru', 'su', 'cn', 'info', 'xyz', 'club', 'support', 'top', 'click', 'zip', 'kim'
];

const HIGH_VALUE_BRANDS = [
    'paypal', 'google', 'microsoft', 'apple', 'amazon', 'facebook', 'instagram',
    'linkedin', 'netflix', 'outlook', 'office365', 'coinbase', 'binance',
    'bankofamerica', 'chase', 'wellsfargo', 'docusign', 'adobe', 'intuit', 'stripe', 'nubank'
];

const SENSITIVE_LINK_WORDS = [
    'login', 'verify', 'update', 'reset', 'unlock', 'secure', 'payment', 'invoice', 'credentials'
];

const URGENCY_PATTERNS = [
    /(immediately|right away|within\s+\d+\s+minutes)/i,
    /(final notice|final warning|last chance)/i,
    /(account (?:will be )?suspended|deactivated|locked)/i,
    /(respond before|action required|act now)/i,
    /(unusual activity detected|security alert)/i
];

const SENSITIVE_DATA_PATTERNS = [
    /(one[-\s]?time passcode|otp|two[-\s]?factor|2fa)/i,
    /(social security|ssn)/i,
    /(bank account|routing number)/i,
    /(gift card code|scratch off)/i,
    /(crypto wallet|seed phrase)/i,
    /(reset your password|confirm password)/i
];

const ATTACHMENT_PHRASES = [
    /(open the attached|download the attachment|view attachment)/i,
    /(attached form|attached invoice|attached statement)/i
];

function extractSenderDomain(fromField = '') {
    const emailMatch = fromField.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
    if (emailMatch && emailMatch[1]) {
        return emailMatch[1].toLowerCase();
    }
    try {
        const url = new URL(fromField);
        return url.hostname.toLowerCase();
    } catch {
        return null;
    }
}

function normalizeLinkRecords(emailData = {}) {
    if (Array.isArray(emailData.linkDetails) && emailData.linkDetails.length) {
        return emailData.linkDetails
            .filter(item => item && item.href)
            .map(item => ({
                href: item.href,
                text: (item.text || '').trim(),
                logoAlt: (item.logoAlt || '').trim(),
                hasImage: Boolean(item.hasImage)
            }));
    }

    if (Array.isArray(emailData.links) && emailData.links.length) {
        return emailData.links
            .filter(Boolean)
            .map(href => ({
                href,
                text: '',
                logoAlt: '',
                hasImage: false
            }));
    }

    return [];
}

function analyzeLinks(linkRecords = [], emailText = '', senderDomain = null) {
    const linkIndicators = [];
    let score = 0;

    linkRecords.forEach(linkItem => {
        try {
            const href = typeof linkItem === 'string' ? linkItem : linkItem.href;
            if (!href) {
                return;
            }

            const displayText = typeof linkItem === 'object' ? (linkItem.text || '') : '';
            const logoAlt = typeof linkItem === 'object' ? (linkItem.logoAlt || '') : '';
            const hasImage = typeof linkItem === 'object' ? Boolean(linkItem.hasImage) : false;
            const displayLower = displayText.toLowerCase();
            const combinedDisplay = `${displayLower} ${logoAlt.toLowerCase()}`.trim();

            const url = new URL(href);
            const host = url.hostname.toLowerCase();
            const normalizedHost = host.startsWith('www.') ? host.slice(4) : host;
            const hostMentioned = emailText.includes(normalizedHost);
            const tld = host.split('.').pop();

            if (url.protocol !== 'https:') {
                linkIndicators.push(`Unsecured link detected (${url.href})`);
                score += 15;
            }

            if (!hostMentioned) {
                linkIndicators.push(`Link domain ${host} not referenced in the email body/subject`);
                score += 10;
            }

            if (senderDomain && !normalizedHost.endsWith(senderDomain)) {
                linkIndicators.push(`Link domain ${host} differs from sender domain ${senderDomain}`);
                score += 20;
            }

            if (host.includes('xn--')) {
                linkIndicators.push(`Link uses punycode/obfuscated domain (${host})`);
                score += 15;
            }

            if (SUSPICIOUS_TLDS.includes(tld)) {
                linkIndicators.push(`Link uses high-risk TLD .${tld}`);
                score += 15;
            }

            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
                linkIndicators.push(`Link uses raw IP address (${host})`);
                score += 25;
            }

            if (combinedDisplay) {
                const domainMatch = combinedDisplay.match(/([a-z0-9.-]+\.[a-z]{2,})/);
                if (domainMatch) {
                    const claimedDomain = domainMatch[1].replace(/^www\./, '');
                    if (!normalizedHost.includes(claimedDomain)) {
                        linkIndicators.push(`Anchor text references ${claimedDomain} but actual link goes to ${host}`);
                        score += 18;
                    }
                }

                const brandHit = HIGH_VALUE_BRANDS.find(brand => combinedDisplay.includes(brand));
                if (brandHit && !normalizedHost.includes(brandHit)) {
                    linkIndicators.push(`Link presents itself as ${brandHit} but targets ${host}`);
                    score += 20;
                }

                const sensitiveWord = SENSITIVE_LINK_WORDS.find(word => displayLower.includes(word));
                if (sensitiveWord && senderDomain && !normalizedHost.endsWith(senderDomain)) {
                    linkIndicators.push(`"${sensitiveWord}" action link points to ${host}, not the sender's domain`);
                    score += 12;
                }
            }

            if (hasImage && !displayLower.trim()) {
                linkIndicators.push('Link relies on a logo/image without visible domain text.');
                score += 8;
            }
        } catch {
            linkIndicators.push('Malformed link detected (unable to parse)');
            score += 10;
        }
    });

    return { linkIndicators, score };
}

// Local Scan Function
function runLocalBasicScan(emailData, isFallback = false) {
    const body = (emailData.body || '').toLowerCase();
    const subject = (emailData.subject || '').toLowerCase();
    const emailText = `${subject} ${body}`;
    const indicators = [];
    let confidence = 0;
    
    const PHISHING_THRESHOLD = 45; 
    const senderDomain = extractSenderDomain(emailData.senderAddress || emailData.from || '');
    const senderName = (emailData.senderName || '').toLowerCase();

    const keywords = [
        'urgent', 'account suspended', 'verify account', 'click here to update', 
        'password expired', 'payment failed', 'unauthorized access', 'invoice attached',
        'confirm password', 'verify identity', 'bank account', 'update billing',
        'reset your password', 'security alert', 'wire transfer', 'gift card'
    ];
    
    keywords.forEach(kw => {
        if (body.includes(kw) || subject.includes(kw)) {
            indicators.push(`Keyword detected: "${kw}"`);
            confidence += 15;
        }
    });

    URGENCY_PATTERNS.forEach(pattern => {
        if (pattern.test(emailText)) {
            indicators.push('Urgent tone detected (final notice / immediate action).');
            confidence += 10;
        }
    });

    SENSITIVE_DATA_PATTERNS.forEach(pattern => {
        if (pattern.test(emailText)) {
            indicators.push('Message asks for highly sensitive data (password/2FA/financial details).');
            confidence += 12;
        }
    });

    if ((subject.match(/!/g) || []).length >= 3 || (body.match(/!/g) || []).length >= 5) {
        indicators.push('Excessive exclamation marks indicate urgency or scare tactics.');
        confidence += 6;
    }

    if (ATTACHMENT_PHRASES.some(pattern => pattern.test(body))) {
        indicators.push('Mentions an attachment that may contain malware (verify before opening).');
        confidence += 8;
    }

    if (senderName && senderDomain) {
        const matchedBrand = HIGH_VALUE_BRANDS.find(brand => senderName.includes(brand));
        if (matchedBrand && !senderDomain.includes(matchedBrand)) {
            indicators.push(`Sender name claims to be ${matchedBrand} but email domain is ${senderDomain}.`);
            confidence += 18;
        }
    }

    const linkRecords = normalizeLinkRecords(emailData);

    if (linkRecords.length > 0) {
        indicators.push(`Contains ${linkRecords.length} external link(s).`);
        confidence += 8;

        const { linkIndicators, score } = analyzeLinks(linkRecords, emailText, senderDomain);
        if (linkIndicators.length) {
            indicators.push(...linkIndicators);
            confidence += score;
        }
    }

    confidence = Math.min(confidence, 99);
    const isPhishing = confidence >= PHISHING_THRESHOLD; 
    
    let recommendation;
    if (isPhishing) {
        recommendation = "Potential Phishing Detected via Local Scan. Use extreme caution and manually verify the sender and links.";
    } else if (confidence > 0) {
        recommendation = "Email appears safe based on basic local checks, but minor indicators were found. Use caution for complex or novel threats.";
    } else {
        recommendation = "Email appears safe based on basic local checks.";
    }

    if (isFallback) {
        recommendation = `API Scan failed due to error/limit. ${recommendation}`;
    }

    return {
        isPhishing,
        confidence,
        indicators,
        recommendation
    };
}

// OpenRouter API Scan Function
async function analyzeEmailWithOpenRouter(emailData, settings) {
    const apiKey = settings.or_api_key;
    const endpoint = settings.or_endpoint || 'https://openrouter.ai/api/v1/chat/completions';
    const model = settings.or_model || 'meta-llama/llama-3.2-3b-instruct:free';
    const threshold = settings.user_threshold || 70; 
    
    if (!apiKey) {
      throw new Error('API key not configured. Please set it in the extension popup.');
    }

    const linkSummaryList = (() => {
        if (Array.isArray(emailData.links) && emailData.links.length) {
            return emailData.links.slice(0, 10);
        }
        if (Array.isArray(emailData.linkDetails) && emailData.linkDetails.length) {
            return emailData.linkDetails.slice(0, 10).map(link => link.href);
        }
        return [];
    })();

    const prompt = `Analyze this email for phishing indicators. Respond ONLY with a valid JSON object in this exact format (no markdown, no backticks):
{
  "isPhishing": true or false,
  "confidence": number between 0-100,
  "indicators": ["list", "of", "suspicious", "things"],
  "recommendation": "brief recommendation text"
}

Email Details:
From: ${emailData.from}
Subject: ${emailData.subject}
Body: ${emailData.body.substring(0, 2000)}
Links: ${linkSummaryList.join(', ') || 'None provided'}

IMPORTANT: Be conservative in flagging legitimate emails. Only flag as phishing if there are MULTIPLE strong indicators.
Always cross-check link domains against the sender's domain and the email content. Raise confidence when links go to unrelated domains, use non-HTTPS protocols, or request credentials/logins.`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': chrome.runtime.getURL(''),
        'X-Title': 'Phishing Detector Extension'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: 'You are a cybersecurity expert specializing in phishing detection. Respond ONLY with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API request failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    
    if (!content) {
      throw new Error('No response from API');
    }
    
    let jsonStr = content.trim();
    jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid response format from API. Expected JSON object.');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    
    if (typeof result.isPhishing !== 'boolean' || 
        typeof result.confidence !== 'number' ||
        !Array.isArray(result.indicators) ||
        typeof result.recommendation !== 'string') {
      throw new Error('Invalid response structure from API');
    }
    
    if (result.indicators && result.indicators.length > 0) {
        if (!result.isPhishing) {
            console.warn(`AI output was inconsistent. Forcing result to PHISHING.`);
        }
        result.isPhishing = true;
        result.confidence = Math.max(result.confidence, 50); 
    }
    
    if (result.confidence >= threshold && !result.isPhishing) {
      result.isPhishing = true;
      result.recommendation = `Flagged due to high confidence (${result.confidence}%) exceeding threshold (${threshold}%). ${result.recommendation}`;
    }
    
    await chrome.storage.local.set({
      [`analysis_${emailData.emailId || Date.now()}`]: {
        ...result,
        timestamp: Date.now(),
        emailData: {
          from: emailData.from,
          subject: emailData.subject
        },
        settings: {
          model,
          threshold
        }
      }
    });
    
    return result;
}
