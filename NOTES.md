# Notes

Things that were decided the hard way, kept out of the README so it stays short.
Most of them are also written up at length beside the code they describe.

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
play on inaudibly. Autoplay has three settings rather than two, because the
middle one is what most sessions actually want: *on hover* sweeps the map
audibly, *on click* only plays when you land on something deliberately - which
still includes advancing the rating queue and loading a face-off pair - and
*never* plays nothing by itself. Buttons, the space bar and the MIDI keyboard
always play.

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

**The long passes run in workers and say so.** Analysis always did; the
near-duplicate pass did not, and on a corpus of tens of thousands it is minutes
of solid arithmetic. Run on the main thread it froze the tab for the whole run -
its progress callbacks fired, but nothing repainted between them, so the report
of what it was doing arrived once it had finished. It now runs in a worker with
a bar, the stage it is in, elapsed time and an estimate, and a Stop button that
terminates the worker.

**Auditions are cut before the next one renders.** Stopping the old sound only
once the new buffer arrives sounds fine on a plucked patch and terrible on a
pad: anything with a long tail, and anything looping, plays straight through the
gap, and a render that gets superseded never cuts its predecessor at all.

**Auditioning is render-then-play.** Rendering is effectively instant, so what
you hear is bit-identical to what the feature extractor measured, and an A/B
switch can be sample-accurate because both sides already exist as buffers.
