import React, { useEffect, useMemo, useRef, useState } from "react";
import { SongGenerator } from "../song-generator/song_generator.esm.js";

const SECTION_DEFAULTS = { intro:2, verse:8, pre:4, chorus:8, break:8, bridge:4, outro:2 };
const PRESETS = ["Metalcore","Djent","Nu‑Metal","Alt‑Prog"];
const KEYS = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
const SCALES = ["Aeolian (Natural Minor)","Phrygian","Dorian","Harmonic Minor","Locrian (spice)"];
const TUNINGS = ["Drop D (D A D G B E)","Drop C (C G C F A D)","Drop B (B F# B E G# C#)","Drop A (A E A D F# B)"];
const MODEL_LAYER = [
  {
    name: "Stable Audio Open",
    summary: "Latent‑diffusion text→audio tuned for fast, high‑fidelity 44.1 kHz stereo renders."
  },
  {
    name: "MusicGen (AudioCraft)",
    summary: "Autoregressive EnCodec token LM that locks bar structure and supports conditioned edits."
  },
  {
    name: "Spectrogram diffusion (optional)",
    summary: "Riffusion‑style text→mel pipelines for style morphs and creative interpolations."
  }
];
const WORKFLOW_CONTROLS = [
  "Arrangement grid with BPM, meter, and key locks so generation follows the song map.",
  "Deterministic seeds plus non‑destructive 4‑bar regen windows and A/B take management.",
  "Instrument & harmony lanes with per‑lane prompts, chord‑track import, and lane‑only regeneration.",
  "True stems at generation time (multi‑stem MusicGen) with Demucs fallback and 24‑bit/48 kHz exports."
];
const SYSTEM_ARCH = [
  "Next.js front‑end with WebAudio previews, arranger grid, and piano roll hooks.",
  "FastAPI/Node orchestrator with Redis/RQ dispatching GPU workers on Kubernetes; per‑job weight loading and object storage for assets.",
  "Producer LLM agent converts briefs into structured SessionSpec and coordinates model workers, storing a project graph for revision safety.",
  "Audio ops: EnCodec tokenization, resampling, loudness normalization, Demucs separation, FFmpeg utility, HLS streaming, and exports (stems + MIDI + tempo map + optional AAF/VST3/AU)."
];
const STARTERS = [
  { title: "Djent pre metalcore with drill timing and melodic vocals", thumb: "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=900&q=80" },
  { title: "Djent alt R&B style instrumentals", thumb: "https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?auto=format&fit=crop&w=900&q=80" },
  { title: "Djent with demonic vocals", thumb: "https://images.unsplash.com/photo-1464375117522-1311d6a5b81f?auto=format&fit=crop&w=900&q=80" },
  { title: "Djent", thumb: "https://images.unsplash.com/photo-1454922915609-78549ad709bb?auto=format&fit=crop&w=900&q=80" },
  { title: "Djent alt R&B style instrumentals", thumb: "https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?auto=format&fit=crop&w=900&q=80" },
  { title: "Djent", thumb: "https://images.unsplash.com/photo-1454922915609-78549ad709bb?auto=format&fit=crop&w=900&q=80" },
];
const EXPLORE = [
  { label: "Instruments", value: "+1" },
  { label: "Progression", value: "+2" },
  { label: "Key", value: "C#" },
  { label: "Seed", value: "48" },
  { label: "Time signature", value: "4/4" },
];

export default function App(){
  const [preset, setPreset] = useState("Metalcore");
  const [key, setKey] = useState("C#");
  const [scale, setScale] = useState("Aeolian (Natural Minor)");
  const [bpm, setBpm] = useState(142);
  const [timeSig, setTimeSig] = useState("4/4");
  const [tuning, setTuning] = useState("Drop C (C G C F A D)");
  const [lengthMin, setLengthMin] = useState(2.8);
  const [title, setTitle] = useState("");
  const [seed, setSeed] = useState(()=>Math.floor(Math.random()*1e9));
  const rng = useMemo(()=>seededRandom(seed), [seed]);
  const profile = useMemo(()=>influenceProfile(preset), [preset]);
  const [timeline, setTimeline] = useState(["intro","verse","pre","chorus","verse","pre","chorus","break","bridge","chorus","outro"]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [clipDuration, setClipDuration] = useState(0);
  const [isRendering, setIsRendering] = useState(false);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const songGen = useMemo(()=> new SongGenerator({ sampleRate: 44100 }), []);

  const arrangementPlan = useMemo(()=> timeline.map(section=>({
    section,
    bars: SECTION_DEFAULTS[section] || 4,
  })), [timeline]);
  const totalBars = arrangementPlan.reduce((sum,s)=> sum + s.bars, 0);
  const barSeconds = beatsPerBarFromTimeSig(timeSig) * beatSeconds(bpm);
  const estimatedSeconds = Math.max(1, totalBars) * barSeconds;

  useEffect(()=>{ setTitle(genTitle(rng, preset, profile)); }, [rng, preset, profile]);

  function buildSessionSpec({ timeline, key, scale, bpm, timeSig, preset, seed, targetMin, targetBars }){
    const baseBars = timeline.map(s=> SECTION_DEFAULTS[s] || 4);
    const bars = normalizeBars({ baseBars, targetMin, targetBars, bpm, timeSig });
    const structure = timeline.map((section, i)=> ({ name: friendlySectionName(section), bars: bars[i] }));
    return {
      seed,
      style: preset,
      key,
      mode: scaleToMode(scale),
      bpm,
      ts: timeSig,
      progression: "I V vi IV",
      structure,
      regen: { lane: 'lead', startBar: 1, bars: 4 }
    };
  }

  function influenceProfile(p){ const b = { rapEnergy:.2, anthem:.25, ambient:.2, djent:.35 }; if (p==="Djent") b.djent=.45; if (p==="Nu‑Metal") b.rapEnergy=.45; if (p==="Alt‑Prog") b.ambient=.35; return b; }

  function startRaf(duration){ const start = performance.now()/1000; const tick = ()=>{ const elapsed = (performance.now()/1000) - start; setPlayProgress(Math.min(duration, elapsed)); if (elapsed < duration && audioRef.current){ rafRef.current = requestAnimationFrame(tick); } else { stop(); } }; rafRef.current = requestAnimationFrame(tick); }

  function stop(){ if (!audioRef.current){ setIsPlaying(false); setPlayProgress(0); return; } try { const { ctx, out, src } = audioRef.current; const t = ctx.currentTime; if (src){ try{ src.stop(); }catch{} } out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0.0001, t+0.06); setTimeout(()=>{ try{ ctx.close(); }catch{} audioRef.current=null; }, 80); } finally { cancelAnimationFrame(rafRef.current); setIsPlaying(false); setPlayProgress(0); } }

  function ensureResume(ctx){ if (ctx.state==="suspended" && ctx.resume){ try{ ctx.resume(); }catch{} } }

  async function play(){
    if (audioRef.current){ stop(); return; }
    setIsRendering(true);
    try {
      const spec = buildSessionSpec({ timeline, key, scale, bpm, timeSig, preset, seed, targetMin: lengthMin });
      const { mix, meta } = await songGen.generate(spec);
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      ensureResume(ctx);
      const out = ctx.createGain();
      out.gain.value = 0.85;
      out.connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = mix;
      src.connect(out);
      src.start();
      audioRef.current = { ctx, out, src };
      setIsPlaying(true);
      setClipDuration(meta.totalSec);
      startRaf(meta.totalSec);
    } catch (err) {
      console.error(err);
      stop();
    } finally {
      setIsRendering(false);
    }
  }

  async function exportClip(){ const spec = buildSessionSpec({ timeline, key, scale, bpm, timeSig, preset, seed, targetBars: 16}); await renderAndDownload(spec, `${slug(title||"anvil")}-30s.wav`); }
  async function exportFull(){ const spec = buildSessionSpec({ timeline, key, scale, bpm, timeSig, preset, seed, targetMin: lengthMin }); await renderAndDownload(spec, `${slug(title||"anvil")}-full.wav`); }
  async function exportMidi(){
    setIsRendering(true);
    try {
      const spec = buildSessionSpec({ timeline, key, scale, bpm, timeSig, preset, seed, targetMin: lengthMin });
      await songGen.generate(spec);
      const midi = songGen.exportMidi();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(midi);
      a.download = `${slug(title||"anvil")}.mid`;
      a.click();
      setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      console.error(err);
    } finally {
      setIsRendering(false);
    }
  }

  async function renderAndDownload(spec, name){
    setIsRendering(true);
    try {
      const { mix } = await songGen.generate(spec);
      const wav = songGen.encodeWav(mix);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(wav);
      a.download = name;
      a.click();
      setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      console.error(err);
    } finally {
      setIsRendering(false);
    }
  }

  function addSection(kind){ setTimeline(t=>[...t, kind]); }
  function onDragStart(e, i){ e.dataTransfer.setData("text/plain", String(i)); }
  function onDragOver(e){ e.preventDefault(); }
  function onDrop(e, i){ e.preventDefault(); const from = Number(e.dataTransfer.getData("text/plain")); if (Number.isNaN(from)) return; setTimeline(t=>{ const arr = t.slice(); const tmp = arr[i]; arr[i] = arr[from]; arr[from] = tmp; return arr; }); }
  function removeAt(i){ setTimeline(t=> t.filter((_,idx)=> idx!==i)); }
  function resetTimeline(){ setTimeline(["intro","verse","pre","chorus","verse","pre","chorus","break","bridge","chorus","outro"]); }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-slate-950 text-slate-50">
      <div className="noise-layer" aria-hidden />
      <div className="grid-radial" aria-hidden />
      <div className="pointer-events-none absolute -left-10 top-12 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -right-24 -top-10 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" aria-hidden />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10">
              <AnvilIcon className="h-6 w-6" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">producer.ai</div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300">Metal arranger</div>
            </div>
          </div>
          <div className="hidden items-center gap-4 text-xs text-slate-300 sm:flex">
            <span className="hover:text-white">Product</span>
            <span className="hover:text-white">Showcase</span>
            <span className="hover:text-white">Docs</span>
            <span className="hover:text-white">Roadmap</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportMidi} disabled={isRendering} className="rounded-xl border border-white/15 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:opacity-60">MIDI</button>
            <button onClick={exportClip} disabled={isRendering} className="rounded-xl border border-white/15 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-white/10 disabled:opacity-60">Export 30s</button>
            <button onClick={exportFull} disabled={isRendering} className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950 shadow-[0_10px_50px_-16px_rgba(16,185,129,0.8)] transition hover:bg-emerald-400 disabled:opacity-60">Full render</button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto flex max-w-6xl flex-col gap-12 px-4 pb-16 pt-10">
        <div className="grid items-start gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="space-y-6">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-emerald-200/80">
                <Chip tone="emerald">Live composer</Chip>
                <Chip tone="zinc">Seed #{seed}</Chip>
                <Chip tone="zinc">{timeline.length} sections</Chip>
                <Chip tone="emerald">{fmtTime(estimatedSeconds)} est.</Chip>
              </div>
              <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
                Producer.ai for heavy music & live stems
              </h1>
              <p className="max-w-2xl text-sm text-slate-300">
                Generate arrangement-aware riffs, regenerate 4-bar clips without losing the groove, and export stems that drop straight into your DAW.
              </p>
              <div className="flex flex-wrap gap-2">
                <button onClick={play} disabled={isRendering} className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-emerald-950 shadow-[0_10px_40px_-15px_rgba(16,185,129,0.8)] transition hover:bg-emerald-400 disabled:opacity-60">
                  {isRendering ? "Rendering…" : isPlaying ? "Stop preview" : "Generate & preview"}
                </button>
                <button onClick={stop} className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10">Stop playback</button>
                <button onClick={()=>setSeed(Math.floor(Math.random()*1e9))} className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-200 transition hover:bg-white/10">
                  Shuffle seed
                </button>
                <button onClick={()=>setTitle(genTitle(rng, preset, profile))} className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-200 transition hover:bg-white/10">
                  Regenerate title
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Metric label="Preset" value={preset} description="Influence blend" />
              <Metric label="Tempo" value={`${bpm} BPM`} description={timeSig} />
              <Metric label="Key & scale" value={`${key} • ${scale.split('(')[0].trim()}`} description={tuning} />
              <Metric label="Length" value={`${lengthMin.toFixed(1)} min target`} description={`${fmtTime(estimatedSeconds)} est.`} />
            </div>

            <Card title="Producer-grade workflow">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2 text-sm text-slate-200/90">
                  <p>Every session is mapped as an arrangement grid so stems and MIDI keep the groove when you regen a single bar or lane.</p>
                  <p className="text-slate-400 text-xs">Stem separation happens at generation time with Demucs fallback for true multi-track exports.</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Chip tone="emerald">Lane-based regen</Chip>
                  <Chip tone="zinc">Hybrid Demucs v4</Chip>
                  <Chip tone="emerald">DAW-ready stems</Chip>
                  <Chip tone="zinc">24-bit / 48 kHz</Chip>
                </div>
              </div>
            </Card>
          </section>

          <section className="space-y-4">
            <Card title="Session mixer">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1">
                    <div className="text-xs text-slate-400 mb-1">Title</div>
                    <input value={title} onChange={e=>setTitle(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60" placeholder="Generate a title" />
                  </div>
                  <button onClick={play} disabled={isRendering} className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-semibold text-emerald-950 shadow-[0_8px_30px_-12px_rgba(16,185,129,0.8)] transition hover:bg-emerald-400 disabled:opacity-60">
                    {isPlaying ? "Re-render" : "Preview"}
                  </button>
                </div>
                <ProgressBar value={playProgress} max={clipDuration||1} />
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>{fmtTime(playProgress)} / {fmtTime(clipDuration||0)}</span>
                  <span>{totalBars} bars • {fmtTime(estimatedSeconds)}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select label="Preset" value={preset} onChange={setPreset} options={PRESETS} />
                  <Select label="Key" value={key} onChange={setKey} options={KEYS} />
                  <Select label="Scale" value={scale} onChange={setScale} options={SCALES} />
                  <Select label="Time Sig" value={timeSig} onChange={setTimeSig} options={["4/4","3/4","6/8","7/8","5/4"]} />
                  <Select label="Tuning" value={tuning} onChange={setTuning} options={TUNINGS} />
                  <Slider label={`BPM: ${bpm}`} value={bpm} onChange={setBpm} min={70} max={210} />
                  <Slider label={`Length: ${lengthMin.toFixed(1)} min`} value={lengthMin} onChange={setLengthMin} min={2} max={5} step={0.1} />
                  <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-emerald-200">Influence</div>
                    <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                      <span>Anthemic hooks</span><span className="text-right text-slate-100">{Math.round(profile.anthem*100)}%</span>
                      <span>Rap energy</span><span className="text-right text-slate-100">{Math.round(profile.rapEnergy*100)}%</span>
                      <span>Ambient layer</span><span className="text-right text-slate-100">{Math.round(profile.ambient*100)}%</span>
                      <span>Djent chugs</span><span className="text-right text-slate-100">{Math.round(profile.djent*100)}%</span>
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Song timeline">
              <div className="flex flex-wrap gap-2 mb-2">
                {timeline.map((s,i)=> (
                  <div key={i} draggable onDragStart={(e)=>onDragStart(e,i)} onDragOver={onDragOver} onDrop={(e)=>onDrop(e,i)} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-100 shadow-sm shadow-emerald-500/5 select-none">
                    <span className="capitalize">{friendlySectionName(s)}</span>
                    <button onClick={()=>removeAt(i)} className="text-rose-300">×</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <select onChange={e=>{ if(e.target.value){ addSection(e.target.value); e.target.value=""; } }} defaultValue="" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-100 outline-none">
                  <option value="" disabled>Add section…</option>
                  <option value="intro">Intro</option>
                  <option value="verse">Verse</option>
                  <option value="pre">Pre‑Chorus</option>
                  <option value="chorus">Chorus</option>
                  <option value="break">Breakdown</option>
                  <option value="bridge">Bridge</option>
                  <option value="outro">Outro</option>
                </select>
                <button onClick={resetTimeline} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/10">Reset</button>
              </div>
            </Card>

            <Card title="Arrangement snapshot">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                <span>{timeline.length} sections • drag to reorder</span>
                <span>{totalBars} bars • {fmtTime(estimatedSeconds)}</span>
              </div>
              <div className="space-y-2">
                {arrangementPlan.map((s,i)=> (
                  <div key={`${s.section}-${i}`} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] uppercase tracking-[0.22em] text-emerald-200/80">{String(i+1).padStart(2,'0')}</span>
                      <span className="capitalize text-sm text-white">{friendlySectionName(s.section)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-300">
                      <span>{s.bars} bars</span>
                      <span>{fmtTime(s.bars * barSeconds)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        </div>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card title="Render MIDI with real instruments">
            <div className="grid gap-3 md:grid-cols-2 text-sm text-slate-200/90">
              <div className="space-y-2">
                <p>Export the generated MIDI and run it through pro samplers to get live‑sounding drums and guitars (GGD, Superior Drummer, STL Tones, Neural DSP).</p>
                <ol className="list-decimal list-inside space-y-1 text-slate-200">
                  <li>Click <span className="font-semibold">Export MIDI</span> above.</li>
                  <li>Load the MIDI into your sampler (browser SoundFonts or DAW VSTs).</li>
                  <li>Render stems for drums, bass, chords, and lead to mirror the browser mix.</li>
                </ol>
              </div>
              <div className="space-y-2">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400 mb-1">Browser</div>
                  <p className="text-sm text-slate-200">Pair the MIDI with a SoundFont sampler (Tone.js Sampler or tiny‑sf2) using multi‑sample drum kits and DI guitars re‑amped with IRs.</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400 mb-1">Desktop DAW</div>
                  <p className="text-sm text-slate-200">Drop the MIDI into your DAW and assign GGD, Superior Drummer, STL AmpHub, or Neural DSP for realistic articulations and amp captures.</p>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Pro audio engine blueprint">
            <div className="grid md:grid-cols-2 gap-4">
              <BlueprintSection title="Model layer" items={MODEL_LAYER} tone="emerald" />
              <BlueprintSection title="Pro workflow controls" items={WORKFLOW_CONTROLS} tone="zinc" />
            </div>
            <div className="mt-3">
              <BlueprintSection title="System architecture" items={SYSTEM_ARCH} tone="amber" />
            </div>
          </Card>
        </section>
      </main>
    </div>
  );
}

function friendlySectionName(section){ if (section==="pre") return "Pre‑Chorus"; return section.charAt(0).toUpperCase() + section.slice(1); }

function scaleToMode(scale){ const s=(scale||"").toLowerCase(); return (s.includes("minor") || s.includes("phrygian") || s.includes("dorian") || s.includes("locrian")) ? 'minor' : 'major'; }
function normalizeBars({ baseBars, targetMin, targetBars, bpm, timeSig }){
  let bars = baseBars.slice();
  if (targetBars){
    const sum = bars.reduce((a,b)=>a+b,0) || 1;
    const scale = targetBars / sum;
    bars = bars.map(b=> Math.max(1, Math.round(b*scale)));
  } else if (targetMin){
    const secPerBar = beatsPerBarFromTimeSig(timeSig||'4/4') * beatSeconds(bpm);
    const targetTotal = Math.max(1, Math.round((targetMin*60)/secPerBar));
    const sum = bars.reduce((a,b)=>a+b,0) || 1;
    const scale = targetTotal / sum;
    bars = bars.map(b=> Math.max(1, Math.round(b*scale)));
  }
  return bars;
}

function Card({ title, children }){
  return (
    <div className="bg-[#0d1017] rounded-2xl border border-[#1b202c] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <h3 className="text-sm font-semibold tracking-wide text-slate-200 mb-3">{title}</h3>
      {children}
    </div>
  );
}
function Chip({ children, tone="zinc" }){
  const palette = tone==='emerald' ? 'bg-emerald-500/15 text-emerald-200 border-emerald-300/30' : 'bg-white/5 text-zinc-200 border-white/10';
  return <span className={`text-[11px] px-2.5 py-1 rounded-full border ${palette}`}>{children}</span>;
}
function BlueprintSection({ title, items, tone="zinc" }){
  const palette = tone==='emerald'
    ? 'bg-emerald-500/10 border-emerald-300/30 text-emerald-100'
    : tone==='amber'
      ? 'bg-amber-500/10 border-amber-300/30 text-amber-100'
      : 'bg-white/5 border-white/10 text-slate-100';
  return (
    <div className={`rounded-2xl p-3 border ${palette}`}>
      <div className="text-[11px] uppercase tracking-wide opacity-90 mb-2">{title}</div>
      <ul className="space-y-2 text-sm leading-snug text-slate-100/90">
        {items.map((item, idx)=> {
          const content = typeof item === 'string' ? item : item.summary;
          const heading = typeof item === 'string' ? null : item.name;
          return (
            <li key={idx} className="flex gap-2 items-start">
              <span className="mt-1 h-2 w-2 rounded-full bg-current/70" aria-hidden />
              <div>
                {heading ? <div className="font-semibold text-xs text-white">{heading}</div> : null}
                <div>{content}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
function Select({ label, value, onChange, options }){
  return (
    <label className="flex flex-col text-xs gap-1">
      <span className="text-slate-400">{label}</span>
      <select value={value} onChange={(e)=>onChange(e.target.value)} className="bg-[#0f121a] border border-[#1b202c] rounded-xl px-3 py-2 outline-none text-white">
        {options.map(o=> <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
function Slider({label, value, onChange, min=0, max=100, step=1}){
  return (
    <label className="block text-xs space-y-1">
      <div className="flex items-center justify-between"><span className="text-slate-400">{label}</span><span className="text-slate-400">{typeof value==="number"? Math.round(value) : value}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e)=>onChange(Number(e.target.value))} className="w-full accent-[#7cc7ff]"/>
    </label>
  );
}
function InfluenceBar({ label, value }){
  const pct = Math.round(Math.min(1, Math.max(0, value||0)) * 100);
  return (
    <div>
      <div className="flex items-center justify-between mb-1 text-[11px]"><span className="text-slate-300">{label}</span><span className="text-slate-400">{pct}%</span></div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-[#7cc7ff] via-[#7cc7ff] to-[#7cc7ff]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
function ProgressBar({value, max}){ const pct = Math.max(0, Math.min(1, (max ? value/max : 0))); return (<div className="w-full h-2 bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-[#7cc7ff]" style={{width: `${(pct*100).toFixed(1)}%`}} /></div>); }
function AnvilIcon({className="w-6 h-6"}){ return (<svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden><path d="M21 8h-3l-1-2H7L6 8H3a1 1 0 0 0 0 2h7v2.2l-3.5 1.4a2 2 0 0 0-1.2 1.8V16h14v-0.6a2 2 0 0 0-1.2-1.8L14 12.2V10h7a1 1 0 0 0 0-2z"/></svg>); }

function stepsPerBar(){ return 16; }
function beatSeconds(bpm){ return 60/Math.max(40, Math.min(260, bpm||120)); }
function stepsToSeconds(steps, bpm){ return (steps/4) * beatSeconds(bpm); }
function beatsPerBarFromTimeSig(ts){ const m = /^(\d+)\/(\d+)$/.exec(ts||'4/4'); const num = m? parseInt(m[1],10):4; return num||4; }
function barsForSeconds(bpm, seconds, ts){ const spb = beatsPerBarFromTimeSig(ts||'4/4')*beatSeconds(bpm); return Math.max(1, Math.ceil(seconds / spb)); }
function buildScale(root, name){ const notes = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"]; const idx = notes.indexOf(root); const modes = { "Aeolian (Natural Minor)": [2,1,2,2,1,2,2], "Phrygian": [1,2,2,2,1,2,2], "Dorian": [2,1,2,2,2,1,2], "Harmonic Minor": [2,1,2,2,1,3,1], "Locrian (spice)": [1,2,2,1,2,2,2] }; const steps = modes[name] || modes["Aeolian (Natural Minor)"]; const scale = [root]; let i = idx; for (const s of steps){ i=(i+s)%notes.length; scale.push(notes[i]); } return scale.slice(0,7); }
function degreeToNote(scale, deg){ const i = ((deg-1)%scale.length+scale.length)%scale.length; return scale[i]; }
function lowStringFreqFromTuning(tuning){ const base = String(tuning||'Drop C').slice(5,6); const map = { 'D': 73.416, 'C': 65.406, 'B': 61.735, 'A': 55.000 }; return map[base] || 65.406; }
function noteToSemitone(n){ const map = { C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5, 'F#':6, Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11 }; return map[n]; }
function freqFromNote(n, octave){ const semi = noteToSemitone(n); const midi = (octave+1)*12 + semi; return 440*Math.pow(2, (midi-69)/12); }

function makeSongGrid({ bars, bpm, prof, rng }){ const steps = bars * stepsPerBar(); const kick = Array(steps).fill(0), snare = Array(steps).fill(0), hat = Array(steps).fill(0), chug = Array(steps).fill(0), lead = Array(steps).fill(-1); const role = (b)=> (b<4? 'verse' : b<8? 'pre' : b<12? 'chorus' : 'break'); for (let b=0;b<bars;b++){ const base=b*16; applyRolePatterns({ role: role(b), base, kick, snare, hat, chug, lead, prof, rng }); } return { steps: Array.from({length: steps}, (_,i)=>i), kick, snare, hat, chug, lead }; }
function makeGridFromTimeline({ timeline, bpm, timeSig, preset, prof, rng, targetMin }){ const defaults = { intro:2, verse:8, pre:4, chorus:8, break:8, bridge:4, outro:2 }; let bars = timeline.map(s=> defaults[s] || 4); if (targetMin){ const secPerBar = beatsPerBarFromTimeSig(timeSig||'4/4')*beatSeconds(bpm); const targetBars = Math.max(8, Math.round((targetMin*60)/secPerBar)); const sum = bars.reduce((a,b)=>a+b,0); const scale = targetBars / Math.max(1,sum); bars = bars.map(b=> Math.max(1, Math.round(b*scale))); } const grids = timeline.map((role, i)=> makeSongGridWithRole({ role, bars: bars[i], bpm, prof, rng }) ); return concatGrids(grids); }
function makeSongGridWithRole({ role, bars, bpm, prof, rng }){ const steps = bars * stepsPerBar(); const kick = Array(steps).fill(0), snare = Array(steps).fill(0), hat = Array(steps).fill(0), chug = Array(steps).fill(0), lead = Array(steps).fill(-1); for (let b=0;b<bars;b++){ const base=b*16; applyRolePatterns({ role, base, kick, snare, hat, chug, lead, prof, rng }); } return { steps: Array.from({length: steps}, (_,i)=>i), kick, snare, hat, chug, lead }; }
function applyRolePatterns({ role, base, kick, snare, hat, chug, lead, prof, rng }){ const k = role==='chorus' ? [0,6,8,14] : role==='break' ? [0,2,4,6,8,10,12,14] : role==='pre' ? [0,8,12] : [0,8,11]; const s = [4,12]; const hatsDense = role==='chorus' || prof.anthem>0.3; for (const i of k) kick[base+i] = 1; for (const i of s) snare[base+i] = 1; for (let i=0;i<16;i++){ hat[base+i] = (i%2===0 || (hatsDense && i%1===0)) ? 1 : (rng()<0.2? 1: 0); } const dj = prof.djent>0.3 ? [3,7,11,15] : []; const baseAcc = [0,4,8,12]; const hits = [...baseAcc, ...dj]; for (const i of hits) chug[base+i] = 1; for (let i=0;i<16;i++) if (rng()<0.05) chug[base+i] = 1; if (role==='chorus'){ const motif = [1,5,6,5,4,3]; const places = [0,2,4,6,8,10]; for (let j=0;j<places.length;j++) lead[base+places[j]] = motif[j%motif.length]-1; } }
function concatGrids(grids){ const totalSteps = grids.reduce((s,g)=> s + g.steps.length, 0); const kick = Array(totalSteps).fill(0), snare=Array(totalSteps).fill(0), hat=Array(totalSteps).fill(0), chug=Array(totalSteps).fill(0), lead=Array(totalSteps).fill(-1); let offset=0; for (const g of grids){ for (let i=0;i<g.steps.length;i++){ kick[offset+i]=g.kick[i]; snare[offset+i]=g.snare[i]; hat[offset+i]=g.hat[i]; chug[offset+i]=g.chug[i]; lead[offset+i]=g.lead[i]; } offset+=g.steps.length; } return { steps: Array.from({length: totalSteps}, (_,i)=>i), kick, snare, hat, chug, lead }; }

function createNoiseBuffer(ctx){ const buffer = ctx.createBuffer(1, ctx.sampleRate*1, ctx.sampleRate); const data = buffer.getChannelData(0); for (let i=0;i<data.length;i++) data[i] = (Math.random()*2-1)*0.6; return buffer; }
function makeDistortionCurve(amount=120){ const k = typeof amount === 'number' ? amount : 50; const n = 44100; const curve = new Float32Array(n); const deg = Math.PI / 180; for (let i=0; i<n; ++i){ const x = i*2/n - 1; curve[i] = (3+k)*x*20*deg / (Math.PI + k*Math.abs(x)); } return curve; }
function playKick(ctx, time, dest){ const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.type = 'sine'; osc.frequency.setValueAtTime(130, time); osc.frequency.exponentialRampToValueAtTime(45, time+0.15); gain.gain.setValueAtTime(1.0, time); gain.gain.exponentialRampToValueAtTime(0.001, time+0.22); osc.connect(gain).connect(dest); osc.start(time); osc.stop(time+0.25); return osc; }
function playSnare(ctx, time, dest, noiseBuffer){ const src = ctx.createBufferSource(); src.buffer = noiseBuffer; const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 1800; const gain = ctx.createGain(); gain.gain.setValueAtTime(0.9, time); gain.gain.exponentialRampToValueAtTime(0.0001, time+0.15); src.connect(hp).connect(gain).connect(dest); src.start(time); src.stop(time+0.2); return src; }
function playHat(ctx, time, dest){ const len = 0.06; const noise = ctx.createBufferSource(); noise.buffer = createNoiseBuffer(ctx); const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 6000; const gain = ctx.createGain(); gain.gain.setValueAtTime(0.5, time); gain.gain.exponentialRampToValueAtTime(0.001, time+len); noise.connect(hp).connect(gain).connect(dest); noise.start(time); noise.stop(time+len+0.01); return noise; }
function playChug(ctx, time, dest, freq){ const osc = ctx.createOscillator(); osc.type='sawtooth'; osc.frequency.setValueAtTime(freq, time); const gain = ctx.createGain(); gain.gain.setValueAtTime(0.0001, time); gain.gain.exponentialRampToValueAtTime(0.6, time+0.005); gain.gain.exponentialRampToValueAtTime(0.0001, time+0.09); const shaper = ctx.createWaveShaper(); shaper.curve = makeDistortionCurve(180); const lp = ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value = 1800; lp.Q.value = 0.6; osc.connect(shaper).connect(lp).connect(gain).connect(dest); osc.start(time); osc.stop(time+0.12); return osc; }
function playLead(ctx, time, dest, freq){ const osc = ctx.createOscillator(); osc.type='triangle'; osc.frequency.setValueAtTime(freq, time); const gain = ctx.createGain(); gain.gain.setValueAtTime(0.0001, time); gain.gain.exponentialRampToValueAtTime(0.5, time+0.02); gain.gain.exponentialRampToValueAtTime(0.0001, time+0.3); const delay = ctx.createDelay(0.5); delay.delayTime.value = 0.22; const fb = ctx.createGain(); fb.gain.value = 0.25; delay.connect(fb).connect(delay); osc.connect(gain).connect(dest); osc.connect(delay).connect(dest); osc.start(time); osc.stop(time+0.32); return osc; }

function scheduleBackgroundLayer(ctx, dest, t0, duration, scaleNotes){ const chord = [degreeToNote(scaleNotes,1), degreeToNote(scaleNotes,5), degreeToNote(scaleNotes,6)]; const freqs = chord.map(n=>freqFromNote(n, 3)); for (let i=0;i<freqs.length;i++){ const f = freqs[i]; const osc = ctx.createOscillator(); osc.type='sawtooth'; osc.frequency.setValueAtTime(f, t0); const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (pan) pan.pan.value = i===0? -0.6 : i===2? 0.6 : 0; const lpf = ctx.createBiquadFilter(); lpf.type='lowpass'; lpf.frequency.value = 900; lpf.Q.value = 0.3; const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.22, t0+0.4); g.gain.linearRampToValueAtTime(0.18, t0+duration-0.3); g.gain.linearRampToValueAtTime(0.0001, t0+duration); const delay = ctx.createDelay(0.6); delay.delayTime.value = 0.27 + 0.03*i; const fb = ctx.createGain(); fb.gain.value = 0.2; delay.connect(fb).connect(delay); if (pan) { osc.connect(lpf).connect(g).connect(pan).connect(dest); } else { osc.connect(lpf).connect(g).connect(dest); } osc.connect(delay).connect(dest); osc.start(t0); osc.stop(t0+duration); } }

function slug(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function bufferToWave(buffer){ const numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44; const ab = new ArrayBuffer(length); const view = new DataView(ab); const channels = []; for (let i = 0; i < numOfChan; i++) channels.push(buffer.getChannelData(i)); let offset = 0; let pos = 0; const setUint16 = (d)=>{ view.setUint16(pos, d, true); pos += 2; }; const setUint32 = (d)=>{ view.setUint32(pos, d, true); pos += 4; }; setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan); setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * numOfChan * 2); setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4); while (pos < length) { for (let i = 0; i < numOfChan; i++) { const sample = Math.max(-1, Math.min(1, channels[i][offset] || 0)); view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); pos += 2; } offset++; } return new Blob([view], { type: 'audio/wav' }); }
function seededRandom(seed){ let t=(seed>>>0)+0x6D2B79F5; return function(){ t|=0; t=(t+0x6D2B79F5)|0; let r=Math.imul(t^t>>>15,1|t); r^=r+Math.imul(r^r>>>7,61|r); return ((r^r>>>14)>>>0)/4294967296; }; }

function fmtTime(seconds){ if (!seconds || !Number.isFinite(seconds)) return '0:00'; const m = Math.floor(seconds/60); const s = Math.floor(seconds%60).toString().padStart(2,'0'); return `${m}:${s}`; }
function genTitle(rng, preset, profile){ const moods = ['Ashen','Ember','Midnight','Iron','Neon','Phantom','Cerulean','Spectral']; const nouns = ['Reckoning','Echoes','Siege','Pulse','Monolith','Signal','Warden','Horizon']; const tags = preset.includes('Metal') ? ['Rift','Core','Forged','Forge'] : ['Dream','Flux']; const adj = profile.anthem>0.3 ? 'Anthem of' : 'Rise of'; return `${moods[Math.floor(rng()*moods.length)]} ${nouns[Math.floor(rng()*nouns.length)]}`; }
