import { SongGenerator, downloadBlob } from './song_generator.esm.js';

async function demo(){
  const gen = new SongGenerator({ sampleRate: 44100 });
  const spec = gen.defaultSpec();
  spec.key = 'F#';
  spec.mode = 'minor';
  spec.bpm = 104;
  spec.structure = [
    { name:'Intro', bars:4, chords:'i v bVI v' },
    { name:'Verse', bars:8, chords:'i v i VII' },
    { name:'Chorus', bars:8, chords:'i bVI bIII bVII' },
    { name:'Bridge', bars:4, chords:'bVI v i i' }
  ];

  const { mix } = await gen.generate(spec);
  const wav = await gen.encodeWav(mix);
  downloadBlob(wav, 'procedural-song.wav');
}

demo();
