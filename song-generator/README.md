# Song Generator (ESM) — Songwriter Mode

A drop‑in, deterministic, bar‑aligned song generator for **browser apps**. Produces **stems (AudioBuffers)** for *drums, bass, chords, lead* and a **mix**, with helpers to export **WAV** and **MIDI**. Uses WebAudio offline rendering so it works **entirely client‑side**.

> Updated for more **live/producer-grade tone**: stereo 48 kHz rendering, multi-layered drums with reverb sends, detuned chord stacks with chorus, saturated bass glides, and expressive lead phrasing.

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
