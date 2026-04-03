import { useState, useEffect, useMemo } from 'react';
import { GoogleGenAI } from "@google/genai";
import { 
  auth, db, onAuthStateChanged, login, logout,
  collection, addDoc, query, updateDoc, deleteDoc, doc, onSnapshot, serverTimestamp, orderBy, limit,
  testFirestoreConnection, where, setDoc
} from './firebase';
import { 
  Plus, Settings, History, Play, Save, Copy,
  ChevronRight, User, Loader2, AlertCircle, 
  CheckCircle2, FileText, Cpu, LayoutDashboard, Menu, X,
  Download, Trash2, Home, LogOut, LogIn
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { User as FirebaseUser } from 'firebase/auth';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    // Only retry on potential transient errors (network, 5xx, or specific RPC errors)
    const isTransient = !error.status || error.status >= 500 || error.message?.includes('Rpc failed') || error.message?.includes('xhr error');
    if (retries <= 0 || !isTransient) throw error;
    console.warn(`Retrying API call... (${retries} attempts left)`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return retry(fn, retries - 1, delay * 2);
  }
}

async function handleFirestoreError(error: unknown, operationType: 'create' | 'update' | 'delete' | 'list' | 'get' | 'write', path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Types ---
interface MasterPrompt {
  id: string;
  name: string;
  content: string;
  isActive: boolean;
  updatedAt?: any;
}

interface Generation {
  id: string;
  script: string;
  characterRef?: string;
  prompts: string;
  promptId: string;
  createdAt: any;
}

// --- Default Master Prompt ---
const DEFAULT_MASTER_PROMPT = `(MASTER PROMPT — KING STORYTELLING DOCUMENTARY SCENE GENERATOR

ROLE
You are a world-class cinematic scene prompt generator for high-end TRUE-CRIME and INVESTIGATIVE DOCUMENTARIES.
Your job is to transform a script into a minimum of 12 (up to 20) sequential, highly descriptive cinematic scene prompts.
You must articulate a compelling visual narrative that focuses exclusively on the PEOPLE and their ACTIONS.

CORE RULES (NON-NEGOTIABLE)
1) MINIMUM 12 PROMPTS
For any script provided, you MUST generate at least 12 distinct scene prompts. If the script is long (90s+), aim for 15-20 prompts. Never output fewer than 12.

2) PEOPLE-ONLY VISUALS (STRICT)
Every single scene MUST feature the main character or key human participants (clients, team members, law enforcement, investigators).
The human element is the absolute focus.
DO NOT include: Generic scenery, airports, skylines, empty streets, nature, or landscapes.
DO NOT include: Standalone objects like knives, drugs, weapons, luggage, or evidence.
Objects (like a phone, a product, or a weapon) can ONLY appear if a person is actively holding, using, or interacting with it. The shot must be about the person's action, not the object.

3) DOCUMENTARY STORYTELLING
Articulate each scene as a storytelling moment. Show the "how" and "who":
- The main character planning with their team.
- The main character on a phone call, looking tense.
- A client receiving a product from the character.
- Law enforcement agencies planning an operation (not just a picture of a badge).
- The suspect being interrogated or escorted.

4) SCENE OPENING RULE (MANDATORY)
Each scene MUST begin with a factual, human-centric action statement.
Examples:
- “The main character is meeting with his team in a dimly lit room…”
- “The suspect is being interrogated by two investigators…”
- “The client is receiving the product while looking over his shoulder…”
- “The main character is smoking a cigarette while staring at a wall of monitors…”
- “The suspect is being arrested and handcuffed by law enforcement…”

5) CHARACTER CONSISTENCY
If a character reference is provided, you MUST explicitly state:
“Maintain strict character consistency with the provided reference image.”
Follow this with a vivid description of the character (Age, Ethnicity, Hair, Build, Clothing, Expression).

6) CINEMATIC ARTICULATION
Describe the shot type (Close-up, Medium, Low-angle), lighting (Chiaroscuro, harsh fluorescent, cold blue), mood (Paranoid, authoritative, desperate), and atmosphere (Smoke-filled, sterile, gritty).

OUTPUT FORMAT
For each scene:
Prompt [number]
A single, highly descriptive cinematic paragraph. No bullet points. No meta-commentary.

QUALITY STANDARD
Netflix True-Crime, HBO Documentary, Gritty Investigative Journalism.)`;

// --- Components ---

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [activeTab, setActiveTab] = useState<'generator' | 'prompts' | 'history'>('generator');
  const [masterPrompts, setMasterPrompts] = useState<MasterPrompt[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Persistent Generator State
  const [script, setScript] = useState('');
  const [charRef, setCharRef] = useState('');
  const [result, setResult] = useState<string | null>(null);

  // Connection Test
  useEffect(() => {
    testFirestoreConnection();
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Update user profile in Firestore
        try {
          await setDoc(doc(db, 'users', u.uid), {
            name: u.displayName,
            email: u.email,
            photoUrl: u.photoURL,
            updatedAt: serverTimestamp()
          }, { merge: true });
          
          // Check for admin role
          const isAdminUser = u.email === "rainderzoneoffers@gmail.com";
          setIsAdmin(isAdminUser);
        } catch (err) {
          console.error("User profile sync error:", err);
        }
      } else {
        setIsAdmin(false);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Data Listeners
  useEffect(() => {
    if (!user) return;

    const qPrompts = query(collection(db, 'master_prompts'), orderBy('updatedAt', 'desc'));
    const unsubPrompts = onSnapshot(qPrompts, (snap) => {
      const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as MasterPrompt));
      setMasterPrompts(data);
      
      // Only admin can seed default prompt if empty
      if (data.length === 0 && isAdmin) {
        addDoc(collection(db, 'master_prompts'), {
          name: "Standard True-Crime Generator",
          content: DEFAULT_MASTER_PROMPT,
          isActive: true,
          updatedAt: serverTimestamp()
        });
      }
    }, (err) => {
      console.error("Firestore Prompts Error:", err);
    });

    const qGens = query(
      collection(db, 'generations'), 
      where('uid', '==', user.uid),
      orderBy('createdAt', 'desc'), 
      limit(20)
    );
    const unsubGens = onSnapshot(qGens, (snap) => {
      setGenerations(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Generation)));
    }, (err) => {
      console.error("Firestore Generations Error:", err);
    });

    return () => {
      unsubPrompts();
      unsubGens();
    };
  }, [user, isAdmin]);

  const activePrompt = useMemo(() => masterPrompts.find(p => p.isActive) || masterPrompts[0], [masterPrompts]);

  const handleLogin = async () => {
    try {
      await login();
    } catch (err) {
      console.error("Login failed:", err);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setActiveTab('generator');
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
        <Loader2 className="w-8 h-8 animate-spin text-[#1e40af]" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#0a0a0a] p-4 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full glass-panel p-8 flex flex-col gap-8"
        >
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#1e40af]/20 flex items-center justify-center border border-[#1e40af]/30">
              <img src="/favicon.svg" className="w-10 h-10" alt="Logo" referrerPolicy="no-referrer" />
            </div>
            <h1 className="text-2xl font-bold tracking-tighter uppercase">Scene Engine v1.0</h1>
            <p className="text-xs text-gray-500 max-w-[250px]">
              Cinematic scene prompt generator for high-end documentary filmmaking.
            </p>
          </div>

          <button 
            onClick={handleLogin}
            className="btn-primary w-full flex items-center justify-center gap-3 py-4 uppercase tracking-widest text-sm"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>

          <p className="text-[10px] text-gray-600 uppercase tracking-widest">
            Secure Authentication Required
          </p>
        </motion.div>
      </div>
    );
  }

  const handleTabChange = (tab: 'generator' | 'prompts' | 'history') => {
    setActiveTab(tab);
    setIsSidebarOpen(false);
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#0a0a0a] text-[#e0e0e0]">
      {/* Mobile Header */}
      <header className="md:hidden flex items-center justify-between p-4 border-b border-[#222222] bg-[#0a0a0a] sticky top-0 z-50">
        <div 
          className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={() => handleTabChange('generator')}
        >
          <img src="/favicon.svg" className="w-6 h-6 rounded-md" alt="Logo" referrerPolicy="no-referrer" />
          <span className="font-bold tracking-tighter uppercase text-xs">Scene Engine</span>
        </div>
        <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2">
          {isSidebarOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </header>

      {/* Sidebar / Mobile Menu */}
      <AnimatePresence>
        {(isSidebarOpen || window.innerWidth >= 768) && (
          <motion.aside 
            initial={window.innerWidth < 768 ? { x: -300 } : false}
            animate={{ x: 0 }}
            exit={{ x: -300 }}
            className={cn(
              "fixed md:static inset-0 z-40 w-64 border-r border-[#222222] flex flex-col p-4 gap-6 bg-[#0a0a0a] md:translate-x-0 transition-transform duration-300",
              !isSidebarOpen && "hidden md:flex"
            )}
          >
            <div 
              className="hidden md:flex items-center gap-3 px-2 cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => handleTabChange('generator')}
            >
              <img src="/favicon.svg" className="w-8 h-8 rounded-lg" alt="Logo" referrerPolicy="no-referrer" />
              <span className="font-bold tracking-tighter uppercase text-sm">Scene Engine v1.0</span>
            </div>

            <nav className="flex flex-col gap-1 mt-4 md:mt-0">
              <NavButton 
                active={activeTab === 'generator'} 
                onClick={() => handleTabChange('generator')}
                icon={<Home className="w-4 h-4" />}
                label="Home"
              />
              <NavButton 
                active={activeTab === 'generator'} 
                onClick={() => handleTabChange('generator')}
                icon={<LayoutDashboard className="w-4 h-4" />}
                label="Generator"
              />
              {isAdmin && (
                <NavButton 
                  active={activeTab === 'prompts'} 
                  onClick={() => handleTabChange('prompts')}
                  icon={<Settings className="w-4 h-4" />}
                  label="Prompt Manager"
                />
              )}
              <NavButton 
                active={activeTab === 'history'} 
                onClick={() => handleTabChange('history')}
                icon={<History className="w-4 h-4" />}
                label="History"
              />
            </nav>

            <div className="mt-auto pt-4 border-t border-[#222222]">
              <div className="flex items-center gap-3 px-2 mb-4">
                <div className="w-8 h-8 rounded-full bg-[#222222] flex items-center justify-center overflow-hidden border border-white/10">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="User" referrerPolicy="no-referrer" />
                  ) : (
                    <User className="w-4 h-4" />
                  )}
                </div>
                <div className="flex flex-col overflow-hidden">
                  <span className="text-xs font-bold truncate">{user.displayName || "User"}</span>
                  <span className="text-[10px] text-gray-500 truncate">{isAdmin ? "Administrator" : "Standard User"}</span>
                </div>
              </div>
              <button 
                onClick={handleLogout}
                className="flex items-center gap-3 px-3 py-2 rounded text-xs text-red-400 hover:bg-red-500/10 w-full transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        {activeTab === 'generator' && (
          <GeneratorView 
            key="generator"
            activePrompt={activePrompt} 
            onGenerateStart={() => setIsGenerating(true)}
            onGenerateEnd={() => setIsGenerating(false)}
            isGenerating={isGenerating}
            script={script}
            setScript={setScript}
            charRef={charRef}
            setCharRef={setCharRef}
            result={result}
            setResult={setResult}
            user={user}
          />
        )}
        {activeTab === 'prompts' && (
          <PromptManagerView 
            key="prompts"
            prompts={masterPrompts} 
          />
        )}
        {activeTab === 'history' && (
          <HistoryView 
            key="history"
            generations={generations} 
          />
        )}
      </main>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: any, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-3 py-3 md:py-2 rounded text-xs transition-all duration-200",
        active ? "bg-[#1e40af] text-white font-bold" : "text-gray-400 hover:bg-[#222222] hover:text-white"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PromptSegments({ text }: { text: string }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const segments = useMemo(() => {
    const promptRegex = /(Prompt\s*(?:\[?\d+\]?|#?\d+):?)/gi;
    const parts = text.split(promptRegex);
    
    const result: { title: string; content: string }[] = [];
    let currentTitle = "Intro";
    let currentContent = "";
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.match(promptRegex)) {
        if (currentContent.trim() || currentTitle !== "Intro") {
          result.push({ title: currentTitle, content: currentContent.trim() });
        }
        currentTitle = part.trim();
        currentContent = "";
      } else {
        currentContent += part;
      }
    }
    
    if (currentContent.trim() || currentTitle !== "Intro") {
      result.push({ title: currentTitle, content: currentContent.trim() });
    }
    
    return result;
  }, [text]);

  const copyToClipboard = (content: string, idx: number) => {
    navigator.clipboard.writeText(content);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] uppercase font-bold text-gray-500">Total Scenes: {segments.length}</span>
        {segments.length < 12 && (
          <span className="text-[10px] uppercase font-bold text-red-400 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Below 12-prompt target
          </span>
        )}
      </div>
      {segments.map((seg, idx) => (
        <div key={idx} className="glass-panel p-4 border-l-2 border-l-[#1e40af] group relative bg-white/[0.02]">
          <div className="flex justify-between items-center mb-3">
            <span className="text-[10px] uppercase font-bold text-[#1e40af] tracking-widest">{seg.title}</span>
            <button 
              onClick={() => copyToClipboard(seg.content, idx)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold uppercase transition-all",
                copiedIdx === idx ? "bg-green-500/20 text-green-400" : "bg-white/5 text-gray-400 hover:bg-[#1e40af] hover:text-white"
              )}
            >
              {copiedIdx === idx ? <CheckCircle2 className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedIdx === idx ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap font-medium">
            {seg.content}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- View Components ---

function GeneratorView({ 
  activePrompt, 
  onGenerateStart, 
  onGenerateEnd, 
  isGenerating,
  script,
  setScript,
  charRef,
  setCharRef,
  result,
  setResult,
  user
}: { 
  activePrompt?: MasterPrompt, 
  onGenerateStart: () => void, 
  onGenerateEnd: () => void, 
  isGenerating: boolean,
  script: string,
  setScript: (s: string) => void,
  charRef: string,
  setCharRef: (s: string) => void,
  result: string | null,
  setResult: (s: string | null) => void,
  user: FirebaseUser
}) {
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!script.trim() || !activePrompt) return;
    
    onGenerateStart();
    setError(null);
    setResult(null);

    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error("Gemini API key is missing. Please ensure it is set in the environment.");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = "gemini-3-flash-preview";
      
      const prompt = `
        SYSTEM INSTRUCTION:
        ${activePrompt.content}

        USER SCRIPT:
        ${script}

        ${charRef ? `CHARACTER REFERENCE DESCRIPTION: ${charRef}` : ''}

        MANDATORY FINAL CHECK:
        You MUST generate AT LEAST 12 distinct scene prompts. If the script is short, expand the storytelling detail for each scene to reach the 12-prompt minimum. Do not stop until you have provided 12-20 prompts.
      `;

      const response = await retry(() => ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }));

      const text = response.text;
      if (text) {
        setResult(text);
        try {
          await addDoc(collection(db, 'generations'), {
            uid: user.uid,
            script,
            characterRef: charRef,
            prompts: text,
            promptId: activePrompt.id,
            createdAt: serverTimestamp()
          });
        } catch (fsErr) {
          await handleFirestoreError(fsErr, 'create', 'generations');
        }
      }
    } catch (err: any) {
      console.error("Generation Error:", err);
      let msg = "Failed to generate scenes.";
      
      if (err.message?.includes('Rpc failed') || err.message?.includes('xhr error') || err.message?.includes('500')) {
        msg = "The AI service is experiencing a temporary connection issue (RPC Error). We are retrying, but if this persists, please try again in a moment.";
      } else if (err.message?.includes('quota') || err.message?.includes('429')) {
        msg = "API Quota exceeded or rate limited. Please wait a moment before trying again.";
      } else if (err.message?.includes('API key')) {
        msg = "Authentication error: Invalid or missing API key.";
      } else {
        msg = err.message || msg;
      }
      
      setError(msg);
    } finally {
      onGenerateEnd();
    }
  };

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6 md:gap-8">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b border-[#222222] pb-4 gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tighter uppercase mb-1">King Scene Generator</h2>
          <p className="text-[10px] text-gray-500 italic">Minimum 12 Storytelling Prompts • People-Only Focus</p>
        </div>
        <button 
          onClick={() => { setScript(''); setCharRef(''); setResult(null); }}
          className="btn-secondary text-[10px] uppercase font-bold w-full md:w-auto"
        >
          Reset
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase font-bold text-gray-400 flex items-center gap-2">
              <FileText className="w-3 h-3" />
              Input Script
            </label>
            <textarea 
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Paste your true-crime script here..."
              className="input-field h-48 md:h-64 resize-none text-sm leading-relaxed"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase font-bold text-gray-400 flex items-center gap-2">
              <User className="w-3 h-3" />
              Character Reference
            </label>
            <input 
              type="text"
              value={charRef}
              onChange={(e) => setCharRef(e.target.value)}
              placeholder="e.g. 45yo Caucasian male..."
              className="input-field text-sm"
            />
          </div>

          <button 
            onClick={handleGenerate}
            disabled={isGenerating || !script.trim()}
            className="btn-primary w-full flex items-center justify-center gap-3 uppercase tracking-widest text-sm py-4 disabled:opacity-50"
          >
            {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
            {isGenerating ? "Processing..." : "Generate Scenes"}
          </button>

          {error && (
            <div className="p-3 bg-red-400/10 border border-red-400/20 rounded flex items-center gap-3 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <label className="text-[10px] uppercase font-bold text-gray-400 flex items-center gap-2">
            <ChevronRight className="w-3 h-3" />
            Output Feed
          </label>
          <div className="glass-panel min-h-[300px] md:min-h-[400px] p-4 md:p-6 overflow-y-auto max-h-[500px] md:max-h-[600px] relative">
            {!result && !isGenerating && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 p-4 text-center">
                <Cpu className="w-12 h-12 mb-4 opacity-20" />
                <p className="text-[10px] uppercase tracking-widest">Awaiting system input...</p>
              </div>
            )}
            {isGenerating && (
              <div className="flex flex-col gap-4 animate-pulse">
                <div className="h-4 bg-white/5 rounded w-3/4"></div>
                <div className="h-24 bg-white/5 rounded"></div>
                <div className="h-4 bg-white/5 rounded w-1/2"></div>
                <div className="h-24 bg-white/5 rounded"></div>
              </div>
            )}
            {result && (
              <PromptSegments text={result} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PromptManagerView({ prompts }: { prompts: MasterPrompt[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');

  const startEdit = (p: MasterPrompt) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditContent(p.content);
  };

  const handleSave = async () => {
    if (!editingId) return;
    try {
      await updateDoc(doc(db, 'master_prompts', editingId), {
        name: editName,
        content: editContent,
        updatedAt: serverTimestamp()
      });
      setEditingId(null);
    } catch (err) {
      await handleFirestoreError(err, 'update', `master_prompts/${editingId}`);
    }
  };

  const resetToDefault = () => {
    setEditContent(DEFAULT_MASTER_PROMPT);
  };

  const toggleActive = async (id: string) => {
    try {
      const updates = prompts.map(p => 
        updateDoc(doc(db, 'master_prompts', p.id), { isActive: p.id === id })
      );
      await Promise.all(updates);
    } catch (err) {
      await handleFirestoreError(err, 'update', 'master_prompts/toggle');
    }
  };

  const addNew = async () => {
    try {
      const newDoc = await addDoc(collection(db, 'master_prompts'), {
        name: "New Master Prompt",
        content: DEFAULT_MASTER_PROMPT,
        isActive: false,
        updatedAt: serverTimestamp()
      });
      setEditingId(newDoc.id);
      setEditName("New Master Prompt");
      setEditContent(DEFAULT_MASTER_PROMPT);
    } catch (err) {
      await handleFirestoreError(err, 'create', 'master_prompts');
    }
  };

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-8">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b border-[#222222] pb-4 gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tighter uppercase mb-1">Prompt Manager</h2>
          <p className="text-xs text-gray-500">Configure the core logic of the engine.</p>
        </div>
        <button onClick={addNew} className="btn-primary flex items-center gap-2 text-xs uppercase w-full md:w-auto justify-center">
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 flex flex-col gap-4">
          <label className="text-[10px] uppercase font-bold text-gray-400">Templates</label>
          <div className="flex flex-col gap-2">
            {prompts.map(p => (
              <div 
                key={p.id}
                className={cn(
                  "p-4 glass-panel flex flex-col gap-3 transition-all",
                  p.isActive ? "border-[#1e40af]/50 bg-[#1e40af]/5" : "hover:bg-white/5"
                )}
              >
                <div className="flex justify-between items-start">
                  <span className="text-sm font-bold truncate pr-2">{p.name}</span>
                  {p.isActive && <CheckCircle2 className="w-4 h-4 text-[#1e40af] shrink-0" />}
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => startEdit(p)}
                    className="text-[10px] uppercase font-bold text-gray-400 hover:text-white flex items-center gap-1"
                  >
                    <Settings className="w-3 h-3" />
                    Edit
                  </button>
                  {!p.isActive && (
                    <button 
                      onClick={() => toggleActive(p.id)}
                      className="text-[10px] uppercase font-bold text-[#1e40af] hover:opacity-80 flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" />
                      Activate
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 flex flex-col gap-4">
          <label className="text-[10px] uppercase font-bold text-gray-400">Editor</label>
          {editingId ? (
            <div className="glass-panel p-4 md:p-6 flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] uppercase font-bold text-gray-500">Template Name</label>
                <input 
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="input-field font-bold"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] uppercase font-bold text-gray-500">System Instructions</label>
                <textarea 
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="input-field h-[300px] md:h-[500px] resize-none text-xs font-mono leading-relaxed"
                />
              </div>
              <div className="flex flex-col md:flex-row justify-end gap-3">
                <button onClick={resetToDefault} className="text-[10px] uppercase font-bold text-gray-500 hover:text-white mr-auto">Reset to Default</button>
                <button onClick={() => setEditingId(null)} className="btn-secondary text-xs uppercase font-bold py-3 md:py-2">Cancel</button>
                <button onClick={handleSave} className="btn-primary flex items-center gap-2 text-xs uppercase font-bold py-3 md:py-2 justify-center">
                  <Save className="w-4 h-4" />
                  Save Changes
                </button>
              </div>
            </div>
          ) : (
            <div className="glass-panel h-[300px] md:h-[600px] flex flex-col items-center justify-center text-gray-600">
              <Settings className="w-12 h-12 mb-4 opacity-20" />
              <p className="text-[10px] uppercase tracking-widest">Select a template</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryView({ generations }: { generations: Generation[] }) {
  const [selected, setSelected] = useState<Generation | null>(null);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; type: 'single' | 'all'; id?: string }>({
    isOpen: false,
    type: 'single'
  });

  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    setIsDeleting(id);
    try {
      await deleteDoc(doc(db, 'generations', id));
      if (selected?.id === id) setSelected(null);
    } catch (err) {
      await handleFirestoreError(err, 'delete', `generations/${id}`);
    } finally {
      setIsDeleting(null);
      setConfirmModal({ isOpen: false, type: 'single' });
    }
  };

  const handleClearAll = async () => {
    if (generations.length === 0) return;

    try {
      const promises = generations.map(g => deleteDoc(doc(db, 'generations', g.id)));
      await Promise.all(promises);
      setSelected(null);
    } catch (err) {
      await handleFirestoreError(err, 'delete', 'generations/all');
    } finally {
      setConfirmModal({ isOpen: false, type: 'all' });
    }
  };

  const handleExportAll = () => {
    if (generations.length === 0) return;

    const stripMarkdown = (text: string) => {
      return text.replace(/[*#]/g, '');
    };

    const content = generations.map((g, idx) => {
      const date = g.createdAt?.toDate ? g.createdAt.toDate().toLocaleString() : 'Just now';
      return `LOG ENTRY ${idx + 1}
DATE: ${date}
INPUT SCRIPT:
${stripMarkdown(g.script)}

CHARACTER REFERENCE:
${g.characterRef ? stripMarkdown(g.characterRef) : 'None provided'}

GENERATED PROMPTS:
${stripMarkdown(g.prompts)}

================================================================================
`;
    }).join('\n\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scene_engine_history_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-8">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b border-[#222222] pb-4 gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold tracking-tighter uppercase mb-1">Generation History</h2>
          <p className="text-xs text-gray-500">Review past scene outputs.</p>
        </div>
        <div className="flex flex-col md:flex-row gap-2 w-full md:w-auto">
          <button 
            onClick={() => setConfirmModal({ isOpen: true, type: 'all' })}
            disabled={generations.length === 0}
            className="btn-secondary flex items-center gap-2 text-xs uppercase w-full md:w-auto justify-center disabled:opacity-50 text-red-400 hover:text-red-300"
          >
            <Trash2 className="w-4 h-4" />
            Clear All
          </button>
          <button 
            onClick={handleExportAll}
            disabled={generations.length === 0}
            className="btn-primary flex items-center gap-2 text-xs uppercase w-full md:w-auto justify-center disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            Export All (.txt)
          </button>
        </div>
      </header>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {confirmModal.isOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="glass-panel p-6 max-w-sm w-full flex flex-col gap-6"
            >
              <div className="flex flex-col gap-2">
                <h3 className="text-lg font-bold uppercase tracking-tight">Are you sure?</h3>
                <p className="text-xs text-gray-400">
                  {confirmModal.type === 'all' 
                    ? "This will permanently delete ALL history logs. This action cannot be undone."
                    : "This will permanently delete this log entry."}
                </p>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={() => setConfirmModal({ isOpen: false, type: 'single' })}
                  className="btn-secondary flex-1 text-xs uppercase font-bold py-2"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => confirmModal.type === 'all' ? handleClearAll() : handleDelete(confirmModal.id!)}
                  className="btn-primary flex-1 text-xs uppercase font-bold py-2 bg-red-600 hover:bg-red-500 border-red-600"
                >
                  Confirm Delete
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 flex flex-col gap-4">
          <label className="text-[10px] uppercase font-bold text-gray-400">Recent Logs</label>
          <div className="flex flex-col gap-2 overflow-y-auto max-h-[400px] md:max-h-[700px]">
            {generations.map(g => (
              <div 
                key={g.id}
                onClick={() => setSelected(g)}
                className={cn(
                  "p-4 glass-panel text-left flex flex-col gap-2 transition-all cursor-pointer",
                  selected?.id === g.id ? "border-[#1e40af]/50 bg-[#1e40af]/5" : "hover:bg-white/5"
                )}
              >
                <div className="flex justify-between items-start">
                  <span className="text-[10px] font-bold text-[#1e40af] uppercase tracking-widest">
                    {g.createdAt?.toDate ? g.createdAt.toDate().toLocaleString() : 'Just now'}
                  </span>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmModal({ isOpen: true, type: 'single', id: g.id });
                    }}
                    disabled={isDeleting === g.id}
                    className="p-1 hover:bg-red-500/20 text-gray-600 hover:text-red-400 rounded transition-colors"
                  >
                    {isDeleting === g.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  </button>
                </div>
                <p className="text-xs text-gray-400 line-clamp-2 italic">"{g.script}"</p>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2 flex flex-col gap-4">
          <label className="text-[10px] uppercase font-bold text-gray-400">Log Details</label>
          {selected ? (
            <div className="glass-panel p-4 md:p-8 flex flex-col gap-8 overflow-y-auto max-h-[500px] md:max-h-[700px]">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 border-b border-[#222222] pb-6">
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] uppercase font-bold text-gray-500">Input Script</label>
                  <p className="text-xs text-gray-400 leading-relaxed max-h-32 overflow-y-auto">{selected.script}</p>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] uppercase font-bold text-gray-500">Character Ref</label>
                  <p className="text-xs text-gray-400">{selected.characterRef || "None provided"}</p>
                </div>
              </div>
              <div className="flex flex-col gap-4">
                <label className="text-[10px] uppercase font-bold text-gray-500">Generated Prompts</label>
                <PromptSegments text={selected.prompts} />
              </div>
            </div>
          ) : (
            <div className="glass-panel h-[300px] md:h-[600px] flex flex-col items-center justify-center text-gray-600">
              <History className="w-12 h-12 mb-4 opacity-20" />
              <p className="text-[10px] uppercase tracking-widest">Select a log</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
