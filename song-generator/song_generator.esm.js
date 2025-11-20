/**
 * Song Generator (ESM) – Songwriter Mode
 * --------------------------------------
 * A self-contained, deterministic, bar-aligned song generator for browser apps.
 * - Inputs: SessionSpec (key/mode/BPM/sections/chords/seed)
 * - Outputs: AudioBuffers for stems (drums, bass, chords, lead) + mix,
 *            WAV export (Blob) and MIDI export (Blob).
 * - Deterministic: PRNG (mulberry32) with seed; bar-level regeneration supported.
 *
 * Notes:
 * - This is a procedural synthesis engine to prove UX and integration.
 * - You can swap each lane renderer with calls to model workers later.
 *
 * Usage:
 *   import { SongGenerator } from './song_generator.esm.js';
 *   const gen = new SongGenerator();
 *   const spec = gen.defaultSpec(); // adjust fields as needed
 *   const { stems, mix } = await gen.generate(spec);
 *   const wav = await gen.encodeWav(mix);
 *   // download or pass blobs up your app
 */

// ---------------------- Types (JSDoc for IDEs) ----------------------
/**
 * @typedef {Object} Section
 * @property {string} name
 * @property {number} bars        - integer >=1
 * @property {string} [chords]    - space or hyphen separated progression, e.g. "I V vi IV" or "C G Am F"
 */

/**
 * @typedef {Object} RegenSpec
 * @property {'lead'|'chords'|'bass'|'drums'} lane
 * @property {number} startBar  // 1-based, inclusive
 * @property {number} bars      // count
 */

/**
 * @typedef {Object} SessionSpec
 * @property {number} seed
 * @property {string} style
 * @property {string} key       - e.g., 'C', 'F#', 'Bb'
 * @property {'major'|'minor'} mode
 * @property {number} bpm
 * @property {string} ts        - currently '4/4'
 * @property {string} progression          - fallback progression for sections without 'chords'
 * @property {Section[]} structure
 * @property {RegenSpec} [regen]
 */

// ---------------------- Utils ----------------------
const NOTE_TO_SEMI = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11};
const SEMI_TO_NOTE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const MAJOR = [0,2,4,5,7,9,11];
const MINOR = [0,2,3,5,7,8,10];

/** Seeded PRNG (mulberry32) */
function prng(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function midiToFreq(m){ return 440 * Math.pow(2, (m - 69) / 12); }

/** Roman numeral parser: returns {degree, quality} */
function parseRomanChord(symbol){
  let s = symbol.trim().replace(/°/g, '°');
  const isDim = s.includes('°');
  s = s.replace('°','');
  const upper = s.toUpperCase();
  const DEG = {'I':0,'II':1,'III':2,'IV':3,'V':4,'VI':5,'VII':6};
  const degree = DEG[upper];
  if(degree===undefined) return null;
  let quality = isDim ? 'dim' : (s===upper ? 'maj' : 'min');
  return { degree, quality };
}

/** Simple chord-name parser: 'C', 'Am', 'F#maj', 'Gmin', 'Bbdim' -> {rootSemi, quality} */
function parseNameChord(tok){
  const m = /^([A-Ga-g])([b#]?)(maj|min|m|dim|aug|M)?(7)?$/.exec(tok.trim());
  if(!m) return null;
  let root = m[1].toUpperCase();
  const accidental = m[2] || '';
  const q = (m[3]||'').toLowerCase();
  let quality = 'maj';
  if(q==='m' || q==='min') quality='min';
  else if(q==='dim') quality='dim';
  else if(q==='aug') quality='aug';
  const rootSemi = (NOTE_TO_SEMI[root + accidental] ?? NOTE_TO_SEMI[root]) % 12;
  return { rootSemi, quality };
}

/** Build triad notes around C3..C5 range */
function buildChordByDegree(degree, quality, mode, keySemi){
  const scale = (mode==='minor') ? MINOR : MAJOR;
  const rootSemi = (keySemi + scale[degree]) % 12;
  let root = 48 + rootSemi; // around C3
  let thirdInt = quality==='maj' ? 4 : (quality==='min' ? 3 : 3);
  let fifthInt = quality==='dim' ? 6 : 7;
  const notes = [root, root+thirdInt, root+fifthInt];
  // Keep within 48..72
  for(let i=0;i<notes.length;i++){
    while(notes[i] > 72) notes[i] -= 12;
    while(notes[i] < 48) notes[i] += 12;
  }
  return notes;
}

function buildChordByName(rootSemi, quality){
  let root = 48 + (rootSemi % 12);
  let thirdInt = quality==='maj' ? 4 : (quality==='min' ? 3 : 3);
  let fifthInt = quality==='dim' ? 6 : (quality==='aug' ? 8 : 7);
  const notes = [root, root+thirdInt, root+fifthInt];
  for(let i=0;i<notes.length;i++){
    while(notes[i] > 72) notes[i] -= 12;
    while(notes[i] < 48) notes[i] += 12;
  }
  return notes;
}

function tokenizeProgression(prog){
  if(!prog) return [];
  return prog.split(/[\s\-–—|,;]+/g).filter(Boolean);
}

/** Returns array of chord objects [{notes:[midi...]}, ...] length = bars */
function makeHarmonyMap(structure, defaultProg, keySemi, mode){
  const out = [];
  const secToProg = sec => tokenizeProgression(sec.chords || defaultProg);

  for(const sec of structure){
    const toks = secToProg(sec);
    for(let bar=0; bar<sec.bars; bar++){
      const tok = toks.length ? toks[bar % toks.length] : 'I';
      let notes;
      const rn = parseRomanChord(tok);
      if(rn){
        notes = buildChordByDegree(rn.degree, rn.quality, mode, keySemi);
      } else {
        const cn = parseNameChord(tok);
        if(cn){
          notes = buildChordByName(cn.rootSemi, cn.quality);
        } else {
          // fallback to I
          notes = buildChordByDegree(0, 'maj', mode, keySemi);
        }
      }
      out.push({ notes });
    }
  }
  return out;
}

// ---------------------- WAV Encoding ----------------------
/** @param {AudioBuffer} audioBuffer @returns {Blob} */
function encodeWav(audioBuffer){
  const numChan = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChan * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;

  function writeString(s){ for(let i=0;i<s.length;i++) view.setUint8(offset++, s.charCodeAt(i)); }
  function u16(v){ view.setUint16(offset, v, true); offset+=2; }
  function u32(v){ view.setUint32(offset, v, true); offset+=4; }

  writeString('RIFF'); u32(36 + dataSize); writeString('WAVE');
  writeString('fmt '); u32(16); u16(1); u16(numChan);
  u32(sampleRate); u32(byteRate); u16(blockAlign); u16(16);
  writeString('data'); u32(dataSize);

  // interleave
  const channels = [];
  for(let c=0;c<numChan;c++) channels.push(audioBuffer.getChannelData(c));
  for(let i=0;i<numFrames;i++){
    for(let c=0;c<numChan;c++){
      let s = channels[c][i];
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------------------- MIDI Writer (Type-0 multi-track feel using meta, or Type-1 minimal) ----------------------
/**
 * Minimal MIDI writer (Type 1) with 4 tracks: drums (ch10), bass (ch1), chords (ch2), lead (ch3)
 * @param {Object} params
 * @param {number} params.bpm
 * @param {Array<Object>} drumEvents   // [{startBeat, durBeats, note(=36 or 38 or 42), vel}]
 * @param {Array<Object>} bassEvents   // [{startBeat, durBeats, midi, vel}]
 * @param {Array<Object>} chordEvents  // [{startBeat, durBeats, midis:[...], vel}]
 * @param {Array<Object>} leadEvents   // [{startBeat, durBeats, midi, vel}]
 * @param {number} [ppq=480]
 * @returns {Blob}
 */
function writeMidi({ bpm, drumEvents, bassEvents, chordEvents, leadEvents, ppq = 480 }){
  const tracks = [];
  const tempoUsPerQ = Math.floor(60000000 / bpm);

  function vlq(n){
    const bytes = [];
    let buffer = n & 0x7F;
    while((n >>= 7)){
      buffer <<= 8;
      buffer |= ((n & 0x7F) | 0x80);
    }
    while(true){
      bytes.push(buffer & 0xFF);
      if(buffer & 0x80) buffer >>= 8; else break;
    }
    return bytes;
  }

  function pushMeta(trk, delta, type, data){
    trk.push(...vlq(delta), 0xFF, type, data.length, ...data);
  }
  function pushEvent(trk, delta, status, data1, data2){
    trk.push(...vlq(delta), status, data1, data2);
  }

  function programChangeTrack(ch, program){
    const trk = [];
    pushEvent(trk, 0, 0xC0 | ch, program, 0);
    return trk;
  }

  function buildNoteTrack(ch, events){
    const trk = [];
    // tempo at start (only once in track 0; we'll place meta in track 0 later)
    // sort by start
    const notes = [];
    for(const e of events){
      const onTick = Math.round(e.startBeat * ppq);
      const offTick = Math.round((e.startBeat + e.durBeats) * ppq);
      if(Array.isArray(e.midis)){
        for(const m of e.midis){
          notes.push({onTick, offTick, midi:m, vel:e.vel ?? 96});
        }
      } else {
        notes.push({onTick, offTick, midi:e.midi, vel:e.vel ?? 96});
      }
    }
    notes.sort((a,b)=>a.onTick-b.onTick || a.offTick-b.offTick);

    let lastTick = 0;
    for(const n of notes){
      let delta = n.onTick - lastTick;
      pushEvent(trk, delta, 0x90 | ch, n.midi, n.vel);
      lastTick = n.onTick;
      delta = n.offTick - lastTick;
      pushEvent(trk, delta, 0x80 | ch, n.midi, 0x40);
      lastTick = n.offTick;
    }
    // end of track
    pushMeta(trk, 0, 0x2F, []);
    return trk;
  }

  // Track 0: tempo & markers
  const trk0 = [];
  // tempo
  pushMeta(trk0, 0, 0x51, [ (tempoUsPerQ>>16)&0xFF, (tempoUsPerQ>>8)&0xFF, tempoUsPerQ&0xFF ]);
  pushMeta(trk0, 0, 0x58, [4,2,24,8]); // time signature 4/4
  pushMeta(trk0, 0, 0x2F, []);

  // Other tracks: set programs + notes
  const trkDrums = buildNoteTrack(9, drumEvents.map(d=>({startBeat:d.startBeat, durBeats:d.durBeats, midi:d.note, vel:d.vel??90})));
  const trkBass  = programChangeTrack(0, 33).concat( buildNoteTrack(0, bassEvents) );   // 33 Fingered Bass
  const trkChrd  = programChangeTrack(1, 48).concat( buildNoteTrack(1, chordEvents) );  // 49 Strings (0-based 48)
  const trkLead  = programChangeTrack(2, 81).concat( buildNoteTrack(2, leadEvents) );   // 82 Lead2 (sawtooth) (0-based 81)

  function buildChunk(type, data){
    const header = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    const len = data.length;
    const size = [(len>>24)&0xFF, (len>>16)&0xFF, (len>>8)&0xFF, len&0xFF];
    return new Uint8Array([...header, ...size, ...data]);
  }

  // Header
  const header = buildChunk('MThd', [0x00,0x01, 0x00,0x05, (ppq>>8)&0xFF, ppq&0xFF]); // 5 tracks including tempo

  const chunks = [
    header,
    buildChunk('MTrk', trk0),
    buildChunk('MTrk', trkDrums),
    buildChunk('MTrk', trkBass),
    buildChunk('MTrk', trkChrd),
    buildChunk('MTrk', trkLead),
  ];

  const totalLen = chunks.reduce((a,c)=>a+c.length,0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for(const c of chunks){ out.set(c, off); off += c.length; }
  return new Blob([out], {type: 'audio/midi'});
}

// ---------------------- Core Generator ----------------------
export class SongGenerator {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.sampleRate=44100]
   */
  constructor(opts={}){
    this.sampleRate = opts.sampleRate || 44100;
  }

  /** @returns {SessionSpec} */
  defaultSpec(){
    return {
      seed: Math.floor(Math.random()*2**31),
      style: '',
      key: 'C',
      mode: 'major',
      bpm: 96,
      ts: '4/4',
      progression: 'I V vi IV',
      structure: [
        {name:'Verse', bars:8},
        {name:'Chorus', bars:8},
        {name:'Verse', bars:8},
        {name:'Chorus', bars:8},
        {name:'Bridge', bars:8},
        {name:'Chorus', bars:8}
      ],
      regen: { lane:'lead', startBar:1, bars:4 }
    };
  }

  // ----- Public API -----

  /**
   * Generate stems and mix for a given spec.
   * @param {SessionSpec} spec
   * @returns {Promise<{stems: {drums:AudioBuffer,bass:AudioBuffer,chords:AudioBuffer,lead:AudioBuffer}, mix: AudioBuffer, meta: Object}>}
   */
  async generate(spec){
    const sr = this.sampleRate;
    const beatsPerBar = 4;
    const secPerBeat = 60 / spec.bpm;
    const totalBars = spec.structure.reduce((a,b)=>a+b.bars, 0);
    const totalBeats = totalBars * beatsPerBar;
    const totalSec = totalBeats * secPerBeat;
    const length = Math.ceil(totalSec * sr);
    const keySemi = NOTE_TO_SEMI[spec.key] ?? 0;
    const harmony = makeHarmonyMap(spec.structure, spec.progression, keySemi, spec.mode);

    // Events for MIDI export
    const drumEvents=[]; const bassEvents=[]; const chordEvents=[]; const leadEvents=[];

    // Render stems
    const [drums, bass, chords, lead] = await Promise.all([
      this.#renderDrums(length, sr, spec, drumEvents),
      this.#renderBass(length, sr, spec, harmony, bassEvents),
      this.#renderChords(length, sr, spec, harmony, chordEvents),
      this.#renderLead(length, sr, spec, harmony, leadEvents),
    ]);

    const mix = await this.#mix([drums,bass,chords,lead]);

    const meta = { totalBars, totalBeats, totalSec, key: spec.key, mode: spec.mode, bpm: spec.bpm, sampleRate: sr };

    // attach midi events for export helper
    this._lastMidi = { bpm: spec.bpm, drumEvents, bassEvents, chordEvents, leadEvents };
    return { stems: {drums, bass, chords, lead}, mix, meta };
  }

  /** Export last generated MIDI as Blob */
  exportMidi(){
    if(!this._lastMidi) throw new Error('No MIDI in memory. Call generate() first.');
    return writeMidi(this._lastMidi);
  }

  /** @param {AudioBuffer} buf */
  encodeWav(buf){ return encodeWav(buf); }

  // ----- Private: Synthesis Engines -----

  async #renderDrums(length, sr, spec, midiOut){
    const ctx = new OfflineAudioContext(1, length, sr);
    const beatsPerBar = 4;
    const secPerBeat = 60 / spec.bpm;
    const totalBars = spec.structure.reduce((a,b)=>a+b.bars, 0);
    const totalBeats = totalBars * beatsPerBar;

    const kick = (t)=>{
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(45, t+0.12);
      g.gain.setValueAtTime(1.0, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t+0.15);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t+0.16);
    };
    const snare = (t)=>{
      const src = ctx.createBufferSource();
      const b = ctx.createBuffer(1, Math.round(sr*0.2), sr);
      const d = b.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i] = (Math.random()*2-1)*0.6 * (1 - i/d.length);
      src.buffer = b;
      const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1800; bp.Q.value=0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.6, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t+0.18);
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(t); src.stop(t+0.2);
    };
    const hat = (t, open=false)=>{
      const src = ctx.createBufferSource();
      const b = ctx.createBuffer(1, Math.round(sr*(open?0.14:0.05)), sr);
      const d = b.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i] = (Math.random()*2-1) * (open?0.5:0.3);
      src.buffer = b;
      const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=6000; hp.Q.value=0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(open?0.4:0.25, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (open?0.12:0.04));
      src.connect(hp).connect(g).connect(ctx.destination);
      src.start(t); src.stop(t + (open?0.14:0.06));
    };

    const rng = prng(spec.seed ^ 0xD0F1CE);
    for(let b=0; b<totalBeats; b++){
      const t = b * secPerBeat;
      const beatInBar = b % beatsPerBar;
      if(beatInBar===0 || beatInBar===2){ kick(t); midiOut.push({startBeat:b, durBeats:0.1, note:36, vel:110}); }
      if(beatInBar===1 || beatInBar===3){ snare(t+0.01); midiOut.push({startBeat:b+0.01/spec.bpm*60, durBeats:0.1, note:38, vel:100}); }
      hat(t); hat(t+secPerBeat*0.5);
      if(beatInBar===3) hat(t+secPerBeat*0.8, true);
      // occasional extra kick
      if(beatInBar===1 && rng() < 0.3){ const tt=t+secPerBeat*0.5; kick(tt); midiOut.push({startBeat:b+0.5, durBeats:0.1, note:36, vel:100}); }
    }
    return ctx.startRendering();
  }

  async #renderBass(length, sr, spec, harmony, midiOut){
    const ctx = new OfflineAudioContext(1, length, sr);
    const beatsPerBar = 4;
    const secPerBeat = 60 / spec.bpm;
    const totalBars = harmony.length;

    const bus = ctx.createGain(); bus.gain.value = 0.8; bus.connect(ctx.destination);
    let beatCounter = 0;
    for(let bar=0; bar<totalBars; bar++){
      const chord = harmony[bar].notes;
      const root = clamp(chord[0]-12, 36, 60); // C2..B3
      for(let i=0;i<4;i++){
        const t = (beatCounter) * secPerBeat;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const f = ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value = 200;
        osc.type = 'sawtooth';
        osc.frequency.value = midiToFreq(root);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.6, t+0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + secPerBeat*0.95);
        osc.connect(f).connect(g).connect(bus);
        osc.start(t); osc.stop(t + secPerBeat*0.98);
        midiOut.push({startBeat: beatCounter, durBeats: 0.95, midi: root, vel: 96});
        beatCounter++;
      }
    }
    return ctx.startRendering();
  }

  async #renderChords(length, sr, spec, harmony, midiOut){
    const ctx = new OfflineAudioContext(1, length, sr);
    const beatsPerBar = 4;
    const secPerBeat = 60 / spec.bpm;
    const totalBars = harmony.length;
    const bus = ctx.createGain(); bus.gain.value = 0.6; bus.connect(ctx.destination);

    for(let bar=0; bar<totalBars; bar++){
      const t0 = bar * beatsPerBar * secPerBeat;
      const notes = harmony[bar].notes;
      for(const n of notes){
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const f = ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value = 1800;
        osc.type = 'triangle';
        osc.frequency.value = midiToFreq(n);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.5, t0+0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + beatsPerBar*secPerBeat - 0.02);
        osc.connect(f).connect(g).connect(bus);
        osc.start(t0); osc.stop(t0 + beatsPerBar*secPerBeat - 0.01);
      }
      midiOut.push({startBeat: bar*beatsPerBar, durBeats: beatsPerBar, midis: notes.slice(), vel: 90});
    }
    return ctx.startRendering();
  }

  async #renderLead(length, sr, spec, harmony, midiOut){
    const ctx = new OfflineAudioContext(1, length, sr);
    const beatsPerBar = 4;
    const secPerBeat = 60 / spec.bpm;
    const totalBars = harmony.length;
    const bus = ctx.createGain(); bus.gain.value = 0.5; bus.connect(ctx.destination);

    const keySemi = NOTE_TO_SEMI[spec.key] ?? 0;
    const scale = (spec.mode==='minor') ? MINOR : MAJOR;
    const rng = prng((spec.seed ^ 0xBADA55) >>> 0);
    let current = 72 + keySemi; // around C5

    for(let bar=0; bar<totalBars; bar++){
      const chord = harmony[bar].notes.map(n=>n+12);
      let pos = 0;
      while(pos < beatsPerBar){
        const sixteenth = rng() < 0.4;
        const dur = sixteenth ? 0.25 : 0.5; // beats
        const startBeat = bar*beatsPerBar + pos;
        // choose next target
        let target;
        if(rng() < 0.6){
          target = chord[Math.floor(rng()*chord.length)];
        } else {
          const degree = Math.floor(rng()*7);
          const base = 70 + keySemi + scale[degree] + 12*Math.floor(rng()*2);
          target = clamp(base, 67, 88);
        }
        current = target;
        const start = startBeat * secPerBeat;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2400;
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(midiToFreq(current), start);
        // light vibrato
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain(); lfo.frequency.value = 5; lfoGain.gain.value = 3;
        lfo.connect(lfoGain).connect(osc.frequency);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(0.5, start+0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur*secPerBeat - 0.01);
        osc.connect(f).connect(g).connect(bus);
        osc.start(start); lfo.start(start);
        const stopAt = start + dur*secPerBeat;
        osc.stop(stopAt); lfo.stop(stopAt);
        midiOut.push({startBeat, durBeats: dur, midi: current, vel: 96});
        pos += dur;
      }
    }
    return ctx.startRendering();
  }

  async #mix(buffers){
    const sr = buffers[0].sampleRate;
    const len = Math.max(...buffers.map(b=>b.length));
    const ctx = new OfflineAudioContext(2, len, sr);
    const mix = ctx.createGain(); mix.gain.value = 0.9; mix.connect(ctx.destination);
    buffers.forEach((b,i)=>{
      const src = ctx.createBufferSource();
      src.buffer = b;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i===3 ? 0.15 : (i===2? -0.1 : 0));
      src.connect(pan).connect(mix);
      src.start(0);
    });
    return ctx.startRendering();
  }
}

// ---------------------- Helpers to integrate in your app ----------------------
/**
 * Download a Blob in-browser (optional helper)
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
