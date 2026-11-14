"use client";
import React, { useState, useRef } from "react";
import { 
  Upload, Terminal, Activity, ShieldAlert, Cpu, Download, 
  Play, RefreshCw, Zap, CheckCircle2, AlertTriangle, FileAudio
} from "lucide-react";
import { 
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, 
  Tooltip, CartesianGrid, ReferenceLine 
} from "recharts";


const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface AnalysisResult {
  filename: string;
  duration_seconds: number;
  verdict: {
    detected_grid: "50Hz" | "60Hz" | "INCONCLUSIVE";
    confidence_percent: number;
    primary_evidence: string;
    regions: string[];
  };
  spectrum: {
    frequencies: number[];
    magnitudes_db: number[];
    peak_50hz_db: number;
    peak_60hz_db: number;
    peak_100hz_db: number;
    peak_120hz_db: number;
  };
  enf_drift: Array<{ timestamp_sec: number; frequency_hz: number }>;
}

export default function GridHumDashboard() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"spectrum" | "drift">("spectrum");
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const runAnalysis = async (targetFile?: File, sampleRoute?: string) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      if (sampleRoute) {
        setLoadingMessage(`Synthesizing and analyzing ${sampleRoute.toUpperCase()} grid sample...`);
        const res = await fetch(`${API_BASE}/api/sample/${sampleRoute}`);
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.detail || "Sample analysis failed");
        }
        const data = await res.json();
        setResult(data);
      } else if (targetFile) {
        setLoadingMessage("Decoding audio stream (FFmpeg -> 1kHz Mono) & running Welch FFT...");
        const formData = new FormData();
        formData.append("file", targetFile);

        const res = await fetch(`${API_BASE}/api/analyze`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.detail || "Analysis request failed");
        }
        const data = await res.json();
        setResult(data);
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred during processing.");
    } finally {
      setLoading(false);
      setLoadingMessage("");
    }
  };

  const exportJSON = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gridhum_audit_${result.filename.replace(/\.[^/.]+$/, "")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Format spectrum data for Recharts
  const spectrumChartData = result?.spectrum.frequencies.map((f, i) => ({
    freq: f,
    db: result.spectrum.magnitudes_db[i],
  })) || [];

  const is50Hz = result?.verdict.detected_grid === "50Hz";
  const is60Hz = result?.verdict.detected_grid === "60Hz";
  const accentColor = is50Hz ? "#10b981" : is60Hz ? "#f59e0b" : "#71717a";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-mono selection:bg-zinc-800">
      {/* Top Telemetry Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-30 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-zinc-800 border border-zinc-700 rounded text-emerald-400">
            <Activity className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider flex items-center gap-2">
              GRIDHUM <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">OSINT ENF v1.0</span>
            </h1>
            <p className="text-xs text-zinc-400">Electrical Network Frequency Forensic Workstation</p>
          </div>
        </div>

        <div className="flex items-center space-x-4 text-xs">
          <div className="hidden sm:flex items-center space-x-2 bg-zinc-950 px-3 py-1.5 rounded border border-zinc-800">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Control Panel */}
        <div className="lg:col-span-1 space-y-6">
          
          {/* Upload Card */}
          <div className="bg-zinc-900/80 border border-zinc-800 rounded-lg p-5 shadow-lg backdrop-blur">
            <h2 className="text-sm font-semibold tracking-wider text-zinc-300 mb-3 flex items-center gap-2">
              <Upload className="w-4 h-4 text-zinc-400" /> TARGET UPLOAD & DROPZONE
            </h2>
            
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-zinc-700 hover:border-zinc-500 rounded-lg p-6 text-center cursor-pointer bg-zinc-950/50 transition duration-200 group flex flex-col items-center justify-center"
            >
              <FileAudio className="w-10 h-10 text-zinc-500 group-hover:text-zinc-300 mb-2 transition" />
              <p className="text-xs text-zinc-300 font-medium">
                {file ? file.name : "click to browse"}
              </p>
              <p className="text-[10px] text-zinc-500 mt-1">Supports .mp3, .wav, .mp4, .mov, .ogg (Max 50MB)</p>
              <input 
                ref={fileInputRef} 
                type="file" 
                accept=".mp3,.wav,.mp4,.mov,.ogg" 
                onChange={handleFileChange} 
                className="hidden" 
              />
            </div>

            <button
              onClick={() => file && runAnalysis(file)}
              disabled={!file || loading}
              className="mt-4 w-full bg-zinc-100 hover:bg-white text-zinc-950 font-bold py-2.5 px-4 rounded text-xs transition duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
              {loading ? "PROCESSING FFT..." : "EXECUTE FORENSIC ANALYSIS"}
            </button>
          </div>

          {/* Quick-Test Synthetics */}
          <div className="bg-zinc-900/80 border border-zinc-800 rounded-lg p-5 shadow-lg">
            <h2 className="text-sm font-semibold tracking-wider text-zinc-300 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" /> QUICK-TEST SYNTHETICS
            </h2>
            <p className="text-xs text-zinc-400 mb-4">
              Instantly run synthetic 50Hz (Europe/Asia) or 60Hz (Americas) grid signatures with simulated wandering drift.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => runAnalysis(undefined, "50hz")}
                disabled={loading}
                className="bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-800/60 text-emerald-400 py-2 px-3 rounded text-xs transition font-semibold flex items-center justify-center gap-2"
              >
                <Terminal className="w-3.5 h-3.5" /> Test 50Hz Grid
              </button>
              <button
                onClick={() => runAnalysis(undefined, "60hz")}
                disabled={loading}
                className="bg-amber-950/40 hover:bg-amber-900/50 border border-amber-800/60 text-amber-400 py-2 px-3 rounded text-xs transition font-semibold flex items-center justify-center gap-2"
              >
                <Terminal className="w-3.5 h-3.5" /> Test 60Hz Grid
              </button>
            </div>
          </div>

          {/* Privacy Guarantee Note */}
          <div className="border border-zinc-800 bg-zinc-900/40 p-4 rounded-lg text-xs text-zinc-400 space-y-2">
            <div className="flex items-center gap-2 text-zinc-200 font-semibold">
              <Cpu className="w-4 h-4 text-emerald-400" /> ZERO-RETENTION GUARANTEE
            </div>
            <p className="text-[11px] leading-relaxed">
              All uploads are analyzed purely in-memory on the backend and purged immediately after FFT processing. No audio files are stored.
            </p>
          </div>

        </div>

        {/* Right Telemetry & Results Display Panel */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Loading Banner */}
          {loading && (
            <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-lg text-center space-y-3 shadow-xl">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto text-emerald-400" />
              <p className="text-sm font-semibold text-zinc-200 tracking-wide">{loadingMessage}</p>
              <p className="text-xs text-zinc-500">Executing Welch power spectral density estimation and STFT drift tracking...</p>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="bg-red-950/30 border border-red-900/60 p-4 rounded-lg flex items-start gap-3 text-red-400 text-xs">
              <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">ANALYSIS ERROR</p>
                <p className="mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* Empty State */}
          {!loading && !result && !error && (
            <div className="bg-zinc-900/40 border border-zinc-800 border-dashed rounded-lg p-12 text-center flex flex-col items-center justify-center text-zinc-500">
              <Activity className="w-12 h-12 mb-3 stroke-[1.5]" />
              <p className="text-sm font-medium text-zinc-400">No telemetry data loaded.</p>
              <p className="text-xs mt-1">Upload an audio asset or test a synthetic grid signature to begin investigation.</p>
            </div>
          )}

          {/* Results Workspace */}
          {result && (
            <div className="space-y-6 animate-fadeIn">
              
              {/* Verdict Header Card */}
              <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-5 shadow-xl relative overflow-hidden">
                <div 
                  className="absolute top-0 left-0 right-0 h-1" 
                  style={{ backgroundColor: accentColor }}
                />
                
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                  <div>
                    <span className="text-[10px] uppercase tracking-widest text-zinc-400">Investigation Target</span>
                    <h3 className="text-sm font-bold text-zinc-200">{result.filename} ({result.duration_seconds}s)</h3>
                  </div>
                  <button
                    onClick={exportJSON}
                    className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 px-3 py-1.5 rounded text-xs transition flex items-center gap-2 self-start sm:self-auto"
                  >
                    <Download className="w-3.5 h-3.5" /> Export Audit JSON
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-zinc-800">
                  <div>
                    <span className="text-[10px] text-zinc-400 block">DETECTED GRID</span>
                    <span className="text-xl font-black tracking-wider" style={{ color: accentColor }}>
                      {result.verdict.detected_grid}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-400 block">CONFIDENCE SCORE</span>
                    <span className="text-xl font-bold text-zinc-100">
                      {result.verdict.confidence_percent}%
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-400 block">PRIMARY EVIDENCE</span>
                    <span className="text-xs font-medium text-zinc-300 block mt-0.5">
                      {result.verdict.primary_evidence}
                    </span>
                  </div>
                </div>

                {result.verdict.regions.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-zinc-800/60 text-xs text-zinc-400 flex flex-wrap items-center gap-1.5">
                    <span className="text-zinc-500 mr-1">Geographic Regions:</span>
                    {result.verdict.regions.map((reg, idx) => (
                      <span key={idx} className="px-2 py-0.5 bg-zinc-950 border border-zinc-800 rounded text-[11px] text-zinc-300">
                        {reg}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Harmonic Comparison Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-zinc-900/60 border border-zinc-800 p-3 rounded text-center">
                  <span className="text-[10px] text-zinc-400 block">50Hz Fundamental</span>
                  <span className="text-sm font-bold text-zinc-200 mt-1 block">{result.spectrum.peak_50hz_db} dB</span>
                </div>
                <div className="bg-zinc-900/60 border border-zinc-800 p-3 rounded text-center">
                  <span className="text-[10px] text-zinc-400 block">60Hz Fundamental</span>
                  <span className="text-sm font-bold text-zinc-200 mt-1 block">{result.spectrum.peak_60hz_db} dB</span>
                </div>
                <div className="bg-zinc-900/60 border border-zinc-800 p-3 rounded text-center">
                  <span className="text-[10px] text-zinc-400 block">100Hz Harmonic (2x)</span>
                  <span className="text-sm font-bold text-zinc-200 mt-1 block">{result.spectrum.peak_100hz_db} dB</span>
                </div>
                <div className="bg-zinc-900/60 border border-zinc-800 p-3 rounded text-center">
                  <span className="text-[10px] text-zinc-400 block">120Hz Harmonic (2x)</span>
                  <span className="text-sm font-bold text-zinc-200 mt-1 block">{result.spectrum.peak_120hz_db} dB</span>
                </div>
              </div>

              {/* Interactive Visualization Tab Panel */}
              <div className="bg-zinc-900/85 border border-zinc-800 rounded-lg p-5 shadow-xl">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-800 pb-3">
                  <div className="flex items-center space-x-2">
                    <Activity className="w-4 h-4 text-zinc-400" />
                    <h3 className="text-xs font-bold tracking-wider text-zinc-200">TELEMETRY PLOT & SPECTRAL ANALYSIS</h3>
                  </div>
                  <div className="flex bg-zinc-950 p-1 rounded border border-zinc-800 text-xs">
                    <button
                      onClick={() => setActiveTab("spectrum")}
                      className={`px-3 py-1 rounded transition ${activeTab === "spectrum" ? "bg-zinc-800 text-zinc-100 font-semibold" : "text-zinc-400 hover:text-zinc-200"}`}
                    >
                      Power Spectral Density (PSD)
                    </button>
                    <button
                      onClick={() => setActiveTab("drift")}
                      className={`px-3 py-1 rounded transition ${activeTab === "drift" ? "bg-zinc-800 text-zinc-100 font-semibold" : "text-zinc-400 hover:text-zinc-200"}`}
                    >
                      ENF Drift Time-Series
                    </button>
                  </div>
                </div>

                {/* Chart Rendering */}
                <div className="h-72 w-full pt-2">
                  {activeTab === "spectrum" ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={spectrumChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                        <XAxis 
                          dataKey="freq" 
                          stroke="#71717a" 
                          fontSize={10} 
                          tickFormatter={(val) => `${val}Hz`} 
                        />
                        <YAxis stroke="#71717a" fontSize={10} domain={['auto', 'auto']} />
                        <Tooltip 
                          contentStyle={{ backgroundColor: "#09090b", borderColor: "#27272a", fontSize: "11px", fontFamily: "monospace" }} 
                          formatter={(value: any) => [`${value} dB`, "Magnitude"]}
                          labelFormatter={(label) => `Frequency: ${label} Hz`}
                        />
                        <ReferenceLine x={50} stroke="#10b981" strokeDasharray="2 2" label={{ value: '50Hz', fill: '#10b981', fontSize: 10 }} />
                        <ReferenceLine x={60} stroke="#f59e0b" strokeDasharray="2 2" label={{ value: '60Hz', fill: '#f59e0b', fontSize: 10 }} />
                        <Line type="monotone" dataKey="db" stroke="#38bdf8" strokeWidth={1.5} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={result.enf_drift}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                        <XAxis 
                          dataKey="timestamp_sec" 
                          stroke="#71717a" 
                          fontSize={10} 
                          tickFormatter={(val) => `${val}s`} 
                        />
                        <YAxis 
                          stroke="#71717a" 
                          fontSize={10} 
                          domain={['auto', 'auto']} 
                          tickFormatter={(val) => val.toFixed(2)}
                        />
                        <Tooltip 
                          contentStyle={{ backgroundColor: "#09090b", borderColor: "#27272a", fontSize: "11px", fontFamily: "monospace" }} 
                          formatter={(value: any) => [`${value} Hz`, "Frequency Drift"]}
                          labelFormatter={(label) => `Time: ${label}s`}
                        />
                        <Line type="monotone" dataKey="frequency_hz" stroke={accentColor} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

            </div>
          )}

        </div>

      </main>
    </div>
  );
}