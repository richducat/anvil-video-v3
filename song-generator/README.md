# Song Generator (ESM) — Songwriter Mode

A drop‑in, deterministic, bar‑aligned song generator for **browser apps**. Produces **stems (AudioBuffers)** for *drums, bass, chords, lead* and a **mix**, with helpers to export **WAV** and **MIDI**. Uses WebAudio offline rendering so it works **entirely client‑side**.

> Use this to prove songwriter UX (sections, chords, seeds, exports) then swap in model workers later.

## Install / Use
Copy `song_generator.esm.js` into your app and import it:

```html
<script type="module">
  import { SongGenerator, downloadBlob } from './song_generator.esm.js';

  const gen = new SongGenerator();
  const spec = gen.defaultSpec();
  spec.key = 'Bb';
  spec.mode = 'major';
  spec.bpm = 92;
  // Per‑section chords (Roman numerals or chord names)
  spec.structure = [
    { name:'Verse', bars:8, chords:'I V vi IV' },
    { name:'Chorus', bars:8, chords:'Gm Eb Bb F' },
    { name:'Bridge', bars:8, chords:'ii V I I' }
  ];

  const { stems, mix, meta } = await gen.generate(spec);
  downloadBlob(gen.encodeWav(mix), 'mix.wav');     // export mix
  const midi = gen.exportMidi();                   // export MIDI
  downloadBlob(midi, 'song.mid');

  // individual stems:
downloadBlob(gen.encodeWav(stems.drums), 'drums.wav');
</script>
```

## Rendering MIDI with real instruments

Two options now ship with the generator:

1. **One‑click pro render in the browser** – call `renderInstrumentalMix(spec)` to automatically re‑amp the generated stems through STL/modern‑metal‑inspired drive, cabinet, and room chains, then `encodeWav` to download the upgraded mix:
   ```js
   const { mix } = await gen.renderInstrumentalMix(spec);
   downloadBlob(gen.encodeWav(mix), 'song-pro.wav');
   ```
2. **External sampler route** – export MIDI and feed it into dedicated drum/guitar libraries for even more realism:
   ```js
   const { mix } = await gen.generate(spec);
   const midi = gen.exportMidi();
   downloadBlob(midi, 'song.mid');
   // open in DAW and assign GetGood Drums, Superior Drummer, STL AmpHub, Neural DSP, etc.
   ```

The in-browser chain applies transient shaping to drums, cabinet convolution to guitars, and mild saturation to bass to approximate high-gain amp captures—no plugins required. For maximum fidelity, you can still bounce MIDI to your DAW and render it through your preferred VSTs.
