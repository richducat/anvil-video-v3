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

The generator exposes `exportMidi()` so you can route the same arrangement through higher‑fidelity instruments. To get live‑sounding drums and guitars similar to GetGood Drums, STL Tones, and other pro VST suites, send the exported MIDI into a sampler:

1. Export the MIDI right after generation:
   ```js
   const { mix } = await gen.generate(spec);
   const midi = gen.exportMidi();
   downloadBlob(midi, 'song.mid');
   ```
2. Load the MIDI into your preferred renderer:
   - **Browser**: pair the MIDI with a SoundFont‑based sampler such as [Tone.js Sampler](https://tonejs.github.io/docs/14.7.77/Sampler) or [tiny‑sf2](https://github.com/colxi/tiny-sf2) using multi‑sample drum kits and DI guitar samples re‑amped through an impulse response chain.
   - **Desktop DAW**: drop the MIDI into a DAW session and assign drum/guitar VSTs (GGD, Superior Drummer, STL AmpHub, Neural DSP) to each track for realistic articulations and amp captures.
3. Render stems per track to mirror the browser workflow. The exported MIDI includes timing, key, tempo, and structure so bar alignment matches the generated audio.
4. (Optional) Bounce audio offline at 44.1 kHz/24‑bit for maximum fidelity, then re‑import the WAVs into the app if you need in‑browser playback of the upgraded tones.

This flow lets you prototype arrangements in the browser while leveraging professional sample libraries to achieve lifelike drums and guitars.
