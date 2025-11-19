import React, { useEffect, useMemo, useRef, useState } from "react";

const SECTION_DEFAULTS = { intro:2, verse:8, pre:4, chorus:8, break:8, bridge:4, outro:2 };
const PRESETS = ["Metalcore","Djent","Nu‑Metal","Alt‑Prog"];
const KEYS = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
const SCALES = ["Aeolian (Natural Minor)","Phrygian","Dorian","Harmonic Minor","Locrian (spice)"];
const TUNINGS = ["Drop D (D A D G B E)","Drop C (C G C F A D)","Drop B (B F# B E G# C#)","Drop A (A E A D F# B)"];
const MODEL_LAYER = [
  {
    name: "Stable Audio Open",
    summary: "Latent‑diffusion text→audio (autoencoder + T5 + DiT) tuned for fast, high‑fidelity 44.1 kHz stereo renders and controllable duration."
  },
  {
    name: "MusicGen (AudioCraft)",
    summary: "Autoregressive EnCodec token LM that locks bar structure, supports melody/chord conditioning, and excels at continue edits."
  },
  {
    name: "Spectrogram diffusion (optional)",
    summary: "Riffusion‑style text→mel pipelines for style morphs and creative interpolations."
  }
];
const WORKFLOW_CONTROLS = [
  "Bar/section grid with BPM, meter, and key locks so generation follows the song map.",
  "Deterministic seeds plus non‑destructive 4‑bar regen windows and A/B take management.",
  "Instrument & harmony lanes with per‑lane prompts, chord‑track import, and lane‑only regeneration.",
  "True stems at generation time (multi‑stem MusicGen) with Hybrid Demucs v4 fallback and 24‑bit/48 kHz exports."
];
const SYSTEM_ARCH = [
  "Next.js front‑end with WebAudio previews, arranger grid, and piano roll hooks.",
  "FastAPI/Node orchestrator with Redis/RQ dispatching GPU workers (A100/L40S) on Kubernetes; per‑job weight loading and object storage for assets.",
  "Producer LLM agent converts briefs into structured SessionSpec and coordinates model workers, storing a project graph for revision safety.",
  "Audio ops: EnCodec tokenization, resampling, loudness normalization, Demucs separation, FFmpeg utility, HLS streaming, and exports (stems + MIDI + tempo map + optional AAF/VST3/AU)."
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
  const audioRef = useRef(null);
  const rafRef = useRef(0);

  const arrangementPlan = useMemo(()=> timeline.map(section=>({
    section,
    bars: SECTION_DEFAULTS[section] || 4,
  })), [timeline]);
  const totalBars = arrangementPlan.reduce((sum,s)=> sum + s.bars, 0);
  const barSeconds = beatsPerBarFromTimeSig(timeSig) * beatSeconds(bpm);
  const estimatedSeconds = Math.max(1, totalBars) * barSeconds;

  useEffect(()=>{ setTitle(genTitle(rng, preset, profile)); }, [rng, preset, profile]);

  function influenceProfile(p){ const b = { rapEnergy:.2, anthem:.25, ambient:.2, djent:.35 }; if (p==="Djent") b.djent=.45; if (p==="Nu‑Metal") b.rapEnergy=.45; if (p==="Alt‑Prog") b.ambient=.35; return b; }

  function startRaf(duration){ const start = performance.now()/1000; const tick = ()=>{ const elapsed = (performance.now()/1000) - start; setPlayProgress(Math.min(duration, elapsed)); if (elapsed < duration && audioRef.current){ rafRef.current = requestAnimationFrame(tick); } else { stop(); } }; rafRef.current = requestAnimationFrame(tick); }

  function stop(){ if (!audioRef.current){ setIsPlaying(false); setPlayProgress(0); return; } try { const { ctx, out } = audioRef.current; const t = ctx.currentTime; out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0.0001, t+0.06); setTimeout(()=>{ try{ ctx.close(); }catch{} audioRef.current=null; }, 80); } finally { cancelAnimationFrame(rafRef.current); setIsPlaying(false); setPlayProgress(0); } }

  function ensureResume(ctx){ if (ctx.state==="suspended" && ctx.resume){ try{ ctx.resume(); }catch{} } }

  function play(){ if (audioRef.current){ stop(); return; } const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx(); ensureResume(ctx); const out = ctx.createGain(); out.gain.value = 0.85; const comp = ctx.createDynamicsCompressor(); comp.threshold.value=-12; comp.knee.value=22; comp.ratio.value=10; comp.attack.value=0.003; comp.release.value=0.25; out.connect(comp); comp.connect(ctx.destination); const prof = profile; const grid = makeGridFromTimeline({ timeline, bpm, timeSig, preset, prof, rng: seededRandom(seed), targetMin: lengthMin }); const t0 = ctx.currentTime + 0.08; const noise = createNoiseBuffer(ctx); const lowFreq = lowStringFreqFromTuning(tuning); const scaleNotes = buildScale(key, scale); const dur = stepsToSeconds(grid.steps.length, bpm); scheduleBackgroundLayer(ctx, out, t0, dur, scaleNotes); for (let i=0;i<grid.steps.length;i++){ const t = t0 + stepsToSeconds(i, bpm); if (grid.kick[i]) playKick(ctx, t, out); if (grid.snare[i]) playSnare(ctx, t, out, noise); if (grid.hat[i]) playHat(ctx, t, out); if (grid.chug[i]) playChug(ctx, t, out, lowFreq); const ld = grid.lead[i]; if (ld >= 0) playLead(ctx, t, out, freqFromNote(scaleNotes[ld % scaleNotes.length], 4)); } audioRef.current = { ctx, out }; setIsPlaying(true); setClipDuration(dur); startRaf(dur); }

  async function exportClip(){ const prof = profile; const grid = makeSongGrid({ bars: 16, bpm, prof, rng: seededRandom(seed) }); await renderAndDownload(grid, `${slug(title||"anvil")}-30s.wav`); }
  async function exportFull(){ const prof = profile; const grid = makeGridFromTimeline({ timeline, bpm, timeSig, preset, prof, rng: seededRandom(seed), targetMin: lengthMin }); await renderAndDownload(grid, `${slug(title||"anvil")}-full.wav`); }

  async function renderAndDownload(grid, name){ const sr=48000, t0=0.25; const songDur = stepsToSeconds(grid.steps.length, bpm); const bedTail=0.5, renderTail=1.0; const totalTime = t0 + songDur + bedTail + renderTail; const frames = Math.ceil(totalTime * sr); const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext; const ctx = new OfflineCtx(2, frames, sr); const master = ctx.createGain(); master.gain.value = 0.9; const lim = ctx.createDynamicsCompressor(); lim.threshold.value=-6; lim.knee.value=24; lim.ratio.value=20; lim.attack.value=0.003; lim.release.value=0.12; master.connect(lim); lim.connect(ctx.destination); const noise = createNoiseBuffer(ctx); const lowFreq = lowStringFreqFromTuning(tuning); const scaleNotes = buildScale(key, scale); scheduleBackgroundLayer(ctx, master, t0, songDur + bedTail, scaleNotes); for (let i=0;i<grid.steps.length;i++){ const t = t0 + stepsToSeconds(i, bpm); if (grid.kick[i]) playKick(ctx, t, master); if (grid.snare[i]) playSnare(ctx, t, master, noise); if (grid.hat[i]) playHat(ctx, t, master); if (grid.chug[i]) playChug(ctx, t, master, lowFreq); const ld = grid.lead[i]; if (ld >= 0) playLead(ctx, t, master, freqFromNote(scaleNotes[ld % scaleNotes.length], 4)); } const rendered = await ctx.startRendering(); const wav = bufferToWave(rendered); const a = document.createElement("a"); a.href = URL.createObjectURL(wav); a.download = name; a.click(); URL.revokeObjectURL(a.href); }

  function addSection(kind){ setTimeline(t=>[...t, kind]); }
  function onDragStart(e, i){ e.dataTransfer.setData("text/plain", String(i)); }
  function onDragOver(e){ e.preventDefault(); }
  function onDrop(e, i){ e.preventDefault(); const from = Number(e.dataTransfer.getData("text/plain")); if (Number.isNaN(from)) return; setTimeline(t=>{ const arr = t.slice(); const tmp = arr[i]; arr[i] = arr[from]; arr[from] = tmp; return arr; }); }
  function removeAt(i){ setTimeline(t=> t.filter((_,idx)=> idx!==i)); }
  function resetTimeline(){ setTimeline(["intro","verse","pre","chorus","verse","pre","chorus","break","bridge","chorus","outro"]); }

  return (
    <div className="min-h-[620px] w-full bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-zinc-100 px-4 pb-6">
      <header className="sticky top-0 z-40 backdrop-blur bg-black/40 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-2 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3"><AnvilIcon className="w-7 h-7"/><div className="leading-tight"><div className="text-base font-semibold tracking-tight">ANVIL</div><div className="text-[11px] text-zinc-400 -mt-0.5">Metal Songsmith</div></div></div>
          <div className="flex items-center gap-2">
            <button onClick={exportClip} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs">Export 30s</button>
            <button onClick={exportFull} className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold">Export Full</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto mt-4 space-y-4">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-r from-emerald-500/10 via-emerald-400/5 to-transparent p-4 sm:p-6">
          <div className="absolute -left-10 -top-10 h-28 w-28 rounded-full bg-emerald-500/10 blur-3xl" aria-hidden />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Chip tone="emerald">Live demo ready</Chip>
                <Chip tone="zinc">Seed #{seed}</Chip>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Anvil metal arranger</h1>
              <p className="text-sm text-zinc-300">Dial in a preset, tweak the energy sliders, and audition the song in-browser before exporting full-quality WAVs.</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Chip tone="zinc">{timeline.length} sections</Chip>
                <Chip tone="zinc">{totalBars} bars</Chip>
                <Chip tone="emerald">≈ {fmtTime(estimatedSeconds)}</Chip>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={()=>setSeed(Math.floor(Math.random()*1e9))} className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold">New seed</button>
                <button onClick={()=>setTitle(genTitle(rng, preset, profile))} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs">Regenerate title</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:w-[320px]">
              <Metric label="Preset" value={preset} description="Influence blend" />
              <Metric label="Tempo" value={`${bpm} BPM`} description={timeSig} />
              <Metric label="Key & scale" value={`${key} • ${scale.split('(')[0].trim()}`} description={tuning} />
              <Metric label="Length" value={`${lengthMin.toFixed(1)} min target`} description={`${fmtTime(estimatedSeconds)} est.`} />
            </div>
          </div>
        </div>

        <main className="grid lg:grid-cols-3 gap-4">
          <section className="lg:col-span-2 space-y-4">
            <Card title="Generate & Preview">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Title</div>
                  <input value={title} onChange={e=>setTitle(e.target.value)} className="w-full bg-zinc-900 border border-white/10 rounded-xl px-3 py-2 outline-none" placeholder="Generate a title"/>
                </div>
                <div className="flex items-end gap-2 justify-end">
                  {!isPlaying ? (
                    <button onClick={play} className="px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold">Generate & Play</button>
                  ) : (
                    <button onClick={stop} className="px-4 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-semibold">Stop</button>
                  )}
                </div>
              </div>
              <div className="mt-3">
                <ProgressBar value={playProgress} max={clipDuration||1} />
                <div className="text-[11px] text-zinc-400 mt-1">{fmtTime(playProgress)} / {fmtTime(clipDuration||0)}</div>
              </div>
            </Card>

            <Card title="Arrangement snapshot">
              <div className="flex items-center justify-between text-xs text-zinc-400 mb-2">
                <span>{timeline.length} sections • drag to reorder</span>
                <span>{totalBars} bars • {fmtTime(estimatedSeconds)}</span>
              </div>
              <div className="space-y-2">
                {arrangementPlan.map((s,i)=> (
                  <div key={`${s.section}-${i}`} className="flex items-center justify-between rounded-xl bg-white/5 border border-white/5 px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] uppercase tracking-wide text-emerald-200/80">{String(i+1).padStart(2,'0')}</span>
                      <span className="capitalize text-sm">{friendlySectionName(s.section)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-zinc-300">
                      <span>{s.bars} bars</span>
                      <span>{fmtTime(s.bars * barSeconds)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="Song Timeline">
              <div className="flex flex-wrap gap-2 mb-2">
                {timeline.map((s,i)=> (
                  <div key={i} draggable onDragStart={(e)=>onDragStart(e,i)} onDragOver={onDragOver} onDrop={(e)=>onDrop(e,i)} className="flex items-center gap-1 bg-zinc-800/70 border border-white/10 rounded-xl px-2 py-1 select-none">
                    <span className="text-xs capitalize">{friendlySectionName(s)}</span>
                    <button onClick={()=>removeAt(i)} className="text-xs px-1 text-rose-400">×</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <select onChange={e=>{ if(e.target.value){ addSection(e.target.value); e.target.value=""; } }} defaultValue="" className="bg-zinc-900 border border-white/10 rounded-xl px-3 py-2 outline-none text-xs">
                  <option value="" disabled>Add section…</option>
                  <option value="intro">Intro</option>
                  <option value="verse">Verse</option>
                  <option value="pre">Pre‑Chorus</option>
                  <option value="chorus">Chorus</option>
                  <option value="break">Breakdown</option>
                  <option value="bridge">Bridge</option>
                  <option value="outro">Outro</option>
                </select>
                <button onClick={resetTimeline} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs">Reset</button>
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

          <aside className="space-y-4">
            <Card title="Session">
              <div className="grid grid-cols-2 gap-2">
                <Select label="Preset" value={preset} onChange={setPreset} options={PRESETS} />
                <Select label="Key" value={key} onChange={setKey} options={KEYS} />
                <Select label="Scale" value={scale} onChange={setScale} options={SCALES} />
                <Select label="Time Sig" value={timeSig} onChange={setTimeSig} options={["4/4","3/4","6/8","7/8","5/4"]} />
                <Select label="Tuning" value={tuning} onChange={setTuning} options={TUNINGS} />
                <Slider label={`BPM: ${bpm}`} value={bpm} onChange={setBpm} min={70} max={210} />
                <Slider label={`Length: ${lengthMin.toFixed(1)} min`} value={lengthMin} onChange={setLengthMin} min={2} max={5} step={0.1} />
              </div>
            </Card>

            <Card title="Influence blend">
              <div className="space-y-3 text-xs">
                <InfluenceBar label="Anthemic hooks" value={profile.anthem} />
                <InfluenceBar label="Rap energy" value={profile.rapEnergy} />
                <InfluenceBar label="Ambient layer" value={profile.ambient} />
                <InfluenceBar label="Djent chugs" value={profile.djent} />
              </div>
              <p className="text-[11px] text-zinc-400 mt-3">These faders drive drum density, accent hits, and the balance between atmosphere and attack for each generated section.</p>
            </Card>
          </aside>
        </main>
      </div>
    </div>
  );
}

function friendlySectionName(section){ if (section==="pre") return "Pre‑Chorus"; return section.charAt(0).toUpperCase() + section.slice(1); }

function Card({ title, children }){
  return (
    <div className="bg-white/5 rounded-2xl border border-white/10 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
      <h3 className="text-sm font-semibold tracking-wide text-zinc-200 mb-3">{title}</h3>
      {children}
    </div>
  );
}
function Metric({ label, value, description }){
  return (
    <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="text-sm font-semibold text-white">{value}</div>
      {description ? <div className="text-[11px] text-zinc-500">{description}</div> : null}
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
      : 'bg-white/5 border-white/10 text-zinc-100';
  return (
    <div className={`rounded-2xl p-3 border ${palette}`}>
      <div className="text-[11px] uppercase tracking-wide opacity-90 mb-2">{title}</div>
      <ul className="space-y-2 text-sm leading-snug text-zinc-100/90">
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
    <label className="flex flex-col text-xs">
      <span className="text-zinc-400 mb-1">{label}</span>
      <select value={value} onChange={(e)=>onChange(e.target.value)} className="bg-zinc-900 border border-white/10 rounded-xl px-3 py-2 outline-none">
        {options.map(o=> <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
function Slider({label, value, onChange, min=0, max=100, step=1}){
  return (
    <label className="block text-xs">
      <div className="flex items-center justify-between mb-1"><span className="text-zinc-400">{label}</span><span className="text-zinc-400">{typeof value==="number"? Math.round(value) : value}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e)=>onChange(Number(e.target.value))} className="w-full"/>
    </label>
  );
}
function InfluenceBar({ label, value }){
  const pct = Math.round(Math.min(1, Math.max(0, value||0)) * 100);
  return (
    <div>
      <div className="flex items-center justify-between mb-1"><span className="text-zinc-300">{label}</span><span className="text-zinc-400">{pct}%</span></div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-emerald-500 via-emerald-400 to-emerald-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
function ProgressBar({value, max}){ const pct = Math.max(0, Math.min(1, (max ? value/max : 0))); return (<div className="w-full h-2 bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-emerald-500" style={{width: `${(pct*100).toFixed(1)}%`}} /></div>); }
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
