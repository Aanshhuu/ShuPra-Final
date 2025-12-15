import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore, collection, addDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBjtmGy5tF6fGE3aDjeiiDLp9ssX0K5SOU",
  authDomain: "shupraprotects.firebaseapp.com",
  projectId: "shupraprotects",
  storageBucket: "shupraprotects.firebasestorage.app",
  messagingSenderId: "967929785902",
  appId: "1:967929785902:web:ac60277ab6fc445a0af9bf"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db, onAuthStateChanged, collection, addDoc };