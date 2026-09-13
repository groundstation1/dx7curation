# DX7 curator

There are tens of thousands of free Yamaha DX7 patches on the internet and room
for 128 on the synth. This is a browser app for closing that gap. It renders
every voice you give it, measures what it sounds like, collapses the duplicates,
and draws the rest as a map where patches that sound alike sit together and
hovering plays whatever is under the cursor. You rate one patch per group rather
than all thirty thousand. What comes out is four 32-voice bank files, ordered so
that neighbouring slots sound adjacent, ready to send over MIDI or download.

Everything stays on your machine: the patches, the measurements and your ratings
live in IndexedDB and nothing is uploaded. Chrome only, because it needs WebMIDI.

```bash
npm install
npm run dev
```

[NOTES.md](NOTES.md) has the decisions worth knowing about.
[LICENSE](LICENSE) is not open source, but the FM engine it is built on is:
it is a port of msfa and stays Apache 2.0. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
