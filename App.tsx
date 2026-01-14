
import React, { useState, useEffect, useRef } from 'react';
import { AppMode, Message, GeneratedImage } from './types';
import { chatWithGemini, generateImage, connectLive } from './services/gemini';
import { encode, decode, decodeAudioData } from './utils/audio';

// --- Sub-components (defined outside for performance) ---

const SidebarItem: React.FC<{ 
  mode: AppMode; 
  active: boolean; 
  onClick: (m: AppMode) => void;
  icon: string;
  label: string;
}> = ({ mode, active, onClick, icon, label }) => (
  <button
    onClick={() => onClick(mode)}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
      active 
        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' 
        : 'text-slate-400 hover:bg-slate-800 hover:text-white'
    }`}
  >
    <span className="text-xl">{icon}</span>
    <span className="font-medium">{label}</span>
  </button>
);

const ChatBubble: React.FC<{ msg: Message }> = ({ msg }) => (
  <div className={`flex flex-col mb-6 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
    <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm md:text-base ${
      msg.role === 'user' 
        ? 'bg-indigo-600 text-white' 
        : 'glass-panel text-slate-100'
    }`}>
      {msg.content}
    </div>
    {msg.thinking && (
      <details className="mt-2 ml-2 cursor-pointer">
        <summary className="text-xs text-indigo-400 hover:text-indigo-300 font-medium">View Thoughts</summary>
        <div className="mt-1 p-3 bg-slate-900/50 border border-indigo-500/20 rounded-lg text-xs text-slate-400 italic whitespace-pre-wrap">
          {msg.thinking}
        </div>
      </details>
    )}
  </div>
);

// --- Main App Component ---

const App: React.FC = () => {
  const [activeMode, setActiveMode] = useState<AppMode>(AppMode.CHAT);
  
  // Chat State
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'model', content: "Hello! I'm Lumina. How can I assist you today?", timestamp: Date.now() }
  ]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Image State
  const [imagePrompt, setImagePrompt] = useState('');
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Voice State
  const [isLive, setIsLive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const sessionRef = useRef<any>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const handleSendMessage = async () => {
    if (!inputText.trim()) return;
    
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText,
      timestamp: Date.now()
    };
    
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsTyping(true);

    try {
      const history = messages.map(m => ({
        role: m.role,
        parts: [{ text: m.content }]
      }));
      
      const response = await chatWithGemini(inputText, history);
      
      const modelMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        content: response.text || "I'm sorry, I couldn't process that.",
        timestamp: Date.now(),
        // Extract thinking if available in response?
        // Actually, gemini-3-pro-preview doesn't return thinking via .text property easily in standard SDK,
        // but it is handled internally. If we want to show it, we might need a specific field.
      };
      
      setMessages(prev => [...prev, modelMsg]);
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, {
        id: 'err',
        role: 'model',
        content: "An error occurred while connecting to the neural network.",
        timestamp: Date.now()
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleGenerateImage = async () => {
    if (!imagePrompt.trim()) return;
    setIsGenerating(true);
    try {
      const url = await generateImage(imagePrompt);
      if (url) {
        setGeneratedImages(prev => [{
          id: Date.now().toString(),
          url,
          prompt: imagePrompt,
          timestamp: Date.now()
        }, ...prev]);
        setImagePrompt('');
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  };

  const toggleVoice = async () => {
    if (isLive) {
      sessionRef.current?.close();
      setIsLive(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = outputCtx;

      const sessionPromise = connectLive({
        onopen: () => {
          const source = inputCtx.createMediaStreamSource(stream);
          const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
          scriptProcessor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            const l = inputData.length;
            const int16 = new Int16Array(l);
            for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
            
            const pcmBlob = {
              data: encode(new Uint8Array(int16.buffer)),
              mimeType: 'audio/pcm;rate=16000'
            };

            sessionPromise.then(session => {
              session.sendRealtimeInput({ media: pcmBlob });
            });
          };
          source.connect(scriptProcessor);
          scriptProcessor.connect(inputCtx.destination);
          setIsLive(true);
        },
        onmessage: async (msg: any) => {
          const base64Audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData.data;
          if (base64Audio) {
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
            const buffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
            const source = outputCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(outputCtx.destination);
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += buffer.duration;
            sourcesRef.current.add(source);
            source.onended = () => sourcesRef.current.delete(source);
          }
          if (msg.serverContent?.interrupted) {
            sourcesRef.current.forEach(s => s.stop());
            sourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      alert("Please ensure microphone access is granted.");
    }
  };

  return (
    <div className="flex h-screen w-full bg-slate-950 overflow-hidden">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-72 border-r border-slate-800 bg-slate-900/50 p-6 space-y-8">
        <div className="flex items-center gap-3 px-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <span className="text-2xl">✨</span>
          </div>
          <h1 className="text-2xl font-bold gradient-text">Lumina</h1>
        </div>

        <nav className="flex-1 space-y-2">
          <SidebarItem 
            mode={AppMode.CHAT} 
            active={activeMode === AppMode.CHAT} 
            onClick={setActiveMode} 
            icon="💬" 
            label="Intelligent Chat" 
          />
          <SidebarItem 
            mode={AppMode.IMAGE} 
            active={activeMode === AppMode.IMAGE} 
            onClick={setActiveMode} 
            icon="🎨" 
            label="Image Studio" 
          />
          <SidebarItem 
            mode={AppMode.VOICE} 
            active={activeMode === AppMode.VOICE} 
            onClick={setActiveMode} 
            icon="🎙️" 
            label="Live Voice" 
          />
        </nav>

        <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/20">
          <p className="text-xs text-indigo-300 font-medium mb-1 uppercase tracking-wider">Powered By</p>
          <p className="text-sm text-slate-400 font-semibold">Gemini 3 Pro & Flash</p>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Mobile Navigation Header */}
        <header className="md:hidden flex items-center justify-between p-4 glass-panel border-b border-white/5">
           <h1 className="text-xl font-bold gradient-text">Lumina</h1>
           <div className="flex gap-2">
             <button onClick={() => setActiveMode(AppMode.CHAT)} className={`p-2 rounded-lg ${activeMode === AppMode.CHAT ? 'bg-indigo-600' : 'bg-slate-800'}`}>💬</button>
             <button onClick={() => setActiveMode(AppMode.IMAGE)} className={`p-2 rounded-lg ${activeMode === AppMode.IMAGE ? 'bg-indigo-600' : 'bg-slate-800'}`}>🎨</button>
             <button onClick={() => setActiveMode(AppMode.VOICE)} className={`p-2 rounded-lg ${activeMode === AppMode.VOICE ? 'bg-indigo-600' : 'bg-slate-800'}`}>🎙️</button>
           </div>
        </header>

        {/* View Content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 relative">
          
          {/* CHAT VIEW */}
          {activeMode === AppMode.CHAT && (
            <div className="max-w-4xl mx-auto h-full flex flex-col">
              <div className="flex-1">
                {messages.map(m => <ChatBubble key={m.id} msg={m} />)}
                {isTyping && (
                  <div className="flex items-center gap-2 text-slate-500 text-sm ml-2">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce"></div>
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                    </div>
                    <span>Lumina is thinking...</span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              
              <div className="sticky bottom-0 pt-4 pb-2 bg-slate-950">
                <div className="relative group">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Type a message or ask complex reasoning questions..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-2xl pl-5 pr-14 py-4 text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={isTyping || !inputText.trim()}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* IMAGE VIEW */}
          {activeMode === AppMode.IMAGE && (
            <div className="max-w-5xl mx-auto space-y-8">
              <div className="text-center space-y-2">
                <h2 className="text-4xl font-bold text-white">Creative Studio</h2>
                <p className="text-slate-400">Bring your imagination to life with high-fidelity generations.</p>
              </div>

              <div className="glass-panel p-6 rounded-3xl space-y-4 shadow-2xl">
                <textarea
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  placeholder="A futuristic solarpunk city with floating gardens and neon butterflies..."
                  className="w-full h-32 bg-slate-950/50 border border-slate-800 rounded-2xl p-4 text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none transition-all"
                />
                <button
                  onClick={handleGenerateImage}
                  disabled={isGenerating || !imagePrompt.trim()}
                  className="w-full py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-2xl font-bold text-lg hover:shadow-xl hover:shadow-indigo-500/20 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {isGenerating ? (
                    <>
                      <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      Synthesizing Reality...
                    </>
                  ) : 'Generate Masterpiece'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {generatedImages.map(img => (
                  <div key={img.id} className="group relative glass-panel rounded-2xl overflow-hidden shadow-xl hover:scale-[1.02] transition-transform duration-300">
                    <img src={img.url} alt={img.prompt} className="w-full aspect-square object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-4 flex flex-col justify-end">
                      <p className="text-xs text-white line-clamp-2 italic">"{img.prompt}"</p>
                      <button 
                        onClick={() => {
                          const link = document.createElement('a');
                          link.href = img.url;
                          link.download = `lumina-${img.id}.png`;
                          link.click();
                        }}
                        className="mt-2 text-indigo-400 font-bold text-xs hover:text-indigo-300 flex items-center gap-1"
                      >
                        Download HD
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VOICE VIEW */}
          {activeMode === AppMode.VOICE && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-12">
              <div className="relative">
                <div className={`absolute inset-0 rounded-full bg-indigo-500/20 animate-ping ${isLive ? 'block' : 'hidden'}`}></div>
                <div className={`w-48 h-48 rounded-full flex items-center justify-center transition-all duration-500 ${isLive ? 'bg-indigo-600 shadow-2xl shadow-indigo-500/50 scale-110' : 'bg-slate-800'}`}>
                  {isLive ? (
                    <div className="flex items-center gap-1.5 h-16">
                      {[1,2,3,4,5].map(i => (
                        <div key={i} className={`w-2 bg-white rounded-full animate-pulse`} style={{ height: `${20 + Math.random() * 80}%`, animationDelay: `${i * 0.1}s` }}></div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-6xl">🎙️</span>
                  )}
                </div>
              </div>

              <div className="space-y-4 max-w-md">
                <h2 className="text-4xl font-bold text-white">{isLive ? 'Connected to Lumina' : 'Voice Interaction'}</h2>
                <p className="text-slate-400">Experience near-zero latency audio conversations with Gemini 2.5 Flash Native Audio.</p>
              </div>

              <button
                onClick={toggleVoice}
                className={`px-12 py-5 rounded-3xl font-bold text-xl transition-all shadow-xl ${
                  isLive 
                    ? 'bg-red-500/10 border border-red-500/50 text-red-500 hover:bg-red-500/20' 
                    : 'bg-indigo-600 text-white hover:bg-indigo-500'
                }`}
              >
                {isLive ? 'End Session' : 'Start Conversation'}
              </button>

              <div className="p-6 glass-panel rounded-2xl flex items-start gap-4 max-w-lg text-left">
                <span className="text-2xl mt-1">💡</span>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Lumina's voice engine allows you to talk naturally. You can interrupt, ask questions, or just share your day. Everything is processed in real-time.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
