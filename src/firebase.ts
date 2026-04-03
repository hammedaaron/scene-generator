import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, getDocs, query, where, updateDoc, deleteDoc, doc, onSnapshot, serverTimestamp, orderBy, limit, getDocFromServer, setDoc } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export const login = () => signInWithPopup(auth, googleProvider);
export const logout = () => signOut(auth);

export async function testFirestoreConnection() {
  try {
    // Attempt to fetch a non-existent document from a 'test' collection to verify connectivity
    await getDocFromServer(doc(db, 'test', 'connection-check'));
    console.log("Firestore connection verified.");
  } catch (error: any) {
    if (error.message?.includes('the client is offline') || error.code === 'unavailable') {
      console.error("Firestore connection failed: The client is offline or the backend is unreachable. Please check your Firebase configuration and internet connection.");
    }
    // We don't throw here to avoid crashing the app, but we log the error.
  }
}

export { onAuthStateChanged, collection, addDoc, getDocs, query, where, updateDoc, deleteDoc, doc, onSnapshot, serverTimestamp, orderBy, limit, getDocFromServer, setDoc };
