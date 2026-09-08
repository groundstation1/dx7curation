# DX7 patch curation

A local web app for turning tens of thousands of freely available Yamaha DX7
sysex patches into a curated, musically ordered set of 128 voices, packed as
four 32-voice bank files and sent to an M-Vave FM-1 over WebMIDI.

The bottleneck is human taste, not compute. Everything here exists to reduce the
number of patches you have to listen to, and to make the listening fast when it
happens.

```bash
npm install
npm run dev      # http://localhost:5173
```

Chrome is required for WebMIDI. Nothing leaves the machine: the corpus, the
features and the ratings all live in IndexedDB.

## The pipeline

1. **Ingest** — drop `.syx` files, folders or a `.zip`. Bulk 32-voice dumps,
   single voices, headerless banks, concatenated banks and raw packed streams
   are all read; DX7II supplements and performance data are skipped. Voices are
   deduplicated on the packed bytes *with the name field excluded*, so the same
   patch under twenty names collapses to one, and every name and source it
   arrived under is kept.
2. **Analyse** — each voice is rendered at three pitches and two velocities,
   held then released, plus once more with the mod wheel up, and reduced to a
   61-dimension feature vector. No audio is stored.
3. **Cluster** — two thresholds. Below the *merge* threshold voices are treated
   as the same patch; below the looser *family* threshold they are similar but
   audibly different, and go to the face-off.
4. **Map** — a scatter of the whole corpus where hovering plays what is under
   the cursor. Any of the sixty-odd axes can drive x, y or dot size. Also the diagnostic for the clustering and the categoriser.
5. **Rate** — one representative per family, keyboard-driven, ordered so that
   each next patch is the furthest from everything already covered.
6. **Face-off** — A/B between the distinct sounds inside a surviving family,
   switchable mid-phrase.
7. **Build** — allocate the 128 with per-category floors and ceilings, order
   them as one continuum, write four verified bank files, send over WebMIDI.

## Layout

| | |
|---|---|
| `src/engine/` | The FM engine: a TypeScript port of msfa, as maintained in Dexed |
| `src/sysex/` | Parsing, packing, writing and verifying DX7 sysex |
| `src/features/` | Rendering probes down to comparable numbers |
| `src/cluster/` | Dedupe, near-duplicates, categories, PCA, LDA, whitening, taste |
| `src/alloc/`, `src/order/` | Choosing the 128 and putting them in order |
| `src/ui/` | Views, map rendering, algorithm diagrams, the shared voice panel |
| `test/` | Node scripts; no framework, run them directly |

```bash
node test/run.ts          # sysex round-trips, tuning accuracy, rendering
node test/pipeline.ts     # the whole pipeline end to end on four cartridges
node test/algograph.ts    # all 32 algorithms against their front-panel layouts
node test/phrase.ts       # the audition phrase
node test/drone.ts        # voices that never stop on their own
node test/taste.ts        # the rating model, on synthetic tastes
node test/bend.ts         # pitch bend, measured back off the rendered audio
node test/release.ts      # release times, and whether extrapolating them is honest
node test/interpolate.ts  # blending voices
node test/bench.ts        # render throughput
```

## Decisions worth knowing

**The engine is a direct port, and it is checked.** Rendered pitch is accurate
to a hundredth of a cent, and the parser round-trips the factory cartridges
byte-for-byte. Rendering runs at about 570x realtime, so the full probe over
45,000 voices is roughly a minute across a dozen workers — rendering is not the
bottleneck and never needed a native path.

**`isCarrier` had to be fixed.** Dexed tests the `OUT_BUS_ADD` flag, but that
flag only means "add to whichever bus you are writing to", and several
algorithms have operators that add into an intermediate bus. It over-counts
carriers on eleven of the thirty-two. In Dexed that is harmless — the function
only decides when a note has finished sounding — but here the lowest carrier
sets each voice's perceived fundamental, and therefore its inharmonicity,
brightness and register.

**Release time is extrapolated, not truncated.** A probe that stops before the
tail does used to report its own length, so every slow patch came out the same
and the number moved when the probe changed rather than when the patch did. The
tail now runs four seconds - segments that fall silent exit early, so it costs
nothing on the two thirds that stop inside a second - and where it still
outlasts the probe the decay rate is fitted in dB and extrapolated to 60 dB
down. Against an eight-second probe that estimate is within 10% for the median
long-tailed voice.

**Pitch is derived, not tracked.** A voice's fundamental comes from its
transpose and its lowest carrier's ratio, which is what makes inharmonicity
reliable on bells, where pitch trackers fail. Many bass patches sound two
octaves below the note you play.

**Taste is not one shape.** The rating model is three fitted together: a ridge
regression on the features, an offset per category, and a kernel average of the
ratings of nearby patches. Liking glassy electric pianos *and* filthy basses is
a taste no straight line can express - the two groups pull the line in opposite
directions and it settles on nothing, which is what a cross-validated R² near
zero usually means. Cross-validation picks the blend, so a component that does
not pay for itself contributes nothing and the reported R² stays honest.

**Distances are whitened.** The feature vector is redundant by construction —
several columns measure roughly the same thing — so a plain Euclidean distance
weights concepts by how many features happen to describe them. Whitening removes
that. The map's variation axes get a separate redundancy-weighting for the same
reason, plus a variance normalisation, so no single feature or family can own a
principal axis.

**Categories are rules, not clusters.** Unsupervised clusters rarely land on
musical categories, and when they are wrong there is nothing to adjust. Every
term is a stated assumption, visible on the map and overridable per voice. Names
are a weak prior — except for `lead`, which is not an acoustic category at all
and where the name is allowed to win.

**Blending never averages a tuning.** Ratios, detune, transpose and the pitch
envelope are donated intact from one contributor, and so is the envelope shape.
Averaging them produces a tuning nobody had, and an envelope that sustains less
than any of its inputs.

**Mute and autoplay are separate switches.** Mute silences the output without
losing the volume you set, and stops what is sounding rather than letting it
play on inaudibly. Autoplay governs only the sounds nothing asked for - hover,
advancing the rating queue, loading a face-off pair. Buttons, the space bar and
the MIDI keyboard always play.

**What you play shows up along the bottom edge.** A strip of piano roll
scrolling out of the bottom of the window: horizontal position is pitch, colour
is velocity, held notes bloom where they meet the edge. Only MIDI input draws
there - auditions and the demo phrase do not - so it answers the question that
used to need the transport's note counter: was anything sent, or did something
get sent and make no sound?

**Pitch bend is global, and its range is yours to state.** One value for every
sounding voice, applied to fixed-frequency operators as well as ratio ones, as
on the hardware. How far the wheel bends is set by the controller and cannot be
read back over MIDI, so the transport has a semitone box; two is the default the
DX7 itself powers up with.

**A released note is not always a finished note.** A DX7 envelope's fourth
level is where it settles after key-up, and it does not have to be zero: six of
the 128 factory voices end their release on an audible level and sound forever,
TRAIN at full scale. The hardware ends them by stealing the voice. The live
engine fades a voice out once its envelope has settled, and in any case six
seconds after key-up, so a key you let go of cannot keep sounding under
everything you audition next.

**Auditions are cut before the next one renders.** Stopping the old sound only
once the new buffer arrives sounds fine on a plucked patch and terrible on a
pad: anything with a long tail, and anything looping, plays straight through the
gap, and a render that gets superseded never cuts its predecessor at all.

**Auditioning is render-then-play.** Rendering is effectively instant, so what
you hear is bit-identical to what the feature extractor measured, and an A/B
switch can be sample-accurate because both sides already exist as buffers.

## Credits

The FM engine is a port of
[music-synthesizer-for-android](https://github.com/google/music-synthesizer-for-android)
(Raph Levien, Google), as maintained in [Dexed](https://github.com/asb2m10/dexed)
(Pascal Gauthier). Apache 2.0; the original headers are preserved in the ported
files.

Sysex format from Dave Benson's `sysex-format.txt` and Dexed's documentation,
cross-checked against `probonopd/dx-specs`.

`test/fixtures/` holds four Yamaha factory cartridges, used as the only patches
in the corpus whose intended character is documented and therefore the only
place the analysis can be checked against something other than taste.
