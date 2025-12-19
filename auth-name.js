import { auth, signOut } from './public/firebase-config.js';

// Check if user is authenticated
auth.onAuthStateChanged((user) => {
    if (!user) {
        // No user is signed in, redirect to login
        window.location.href = 'login.html';
    } else {
        // User is signed in
        console.log('User is authenticated:', user.email);
        const deriveName = () => {
            if (user.displayName) return user.displayName;
            if (user.email) {
                const local = user.email.split('@')[0] || user.email;
                return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
            }
            return 'Friend';
        };
        
        // Store user info in chrome storage
        chrome.storage.local.set({
            userEmail: user.email,
            userId: user.uid,
            userName: deriveName(),
            isLoggedIn: true
        });
    }
});

// Logout function that you can call from your dashboard
export async function logout() {
    try {
        await signOut(auth);
        
        // Clear chrome storage
        chrome.storage.local.remove(['userEmail', 'userId', 'isLoggedIn']);
        
        // Redirect to login page
        window.location.href = 'login.html';
    } catch (error) {
        console.error('Error signing out:', error);
    }
}

// Make logout available globally
window.logout = logout;
