// Choosing which radar frame is on screen.
//
// The list of frames is replaced wholesale every ten minutes, and the panel
// outlives many replacements: it is opened, scrubbed, closed, and opened again
// hours later against a list with nothing in common with the one it was left
// on. Every question here is therefore about carrying an intent across a list
// that no longer exists.
//
// An index cannot carry it. A position in one list means nothing in the next,
// and comparing a held index against the new list's length reads as correct
// while quietly moving the user: someone parked on the newest frame of a
// thirteen-frame list, given a list of fourteen, is no longer at the end and
// stops being carried forward. What travels is the moment in time the user was
// looking at, and whether they had chosen to follow the newest.

.pragma library

// Index of the frame nearest a moment, in epoch seconds. Nearest rather than
// exact: the moment being looked at may have aged out of the published window
// entirely, and the closest frame still answers "roughly then" — which is what
// somebody who scrubbed back to it was asking.
function indexNearest(frames, time) {
  if (!frames || frames.length === 0) return -1

  var best = 0
  var bestDistance = Infinity
  for (var i = 0; i < frames.length; i++) {
    var distance = Math.abs(frames[i].time - time)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

// Whether an index names the newest frame in hand.
function isLatest(frames, index) {
  return !!frames && frames.length > 0 && index >= frames.length - 1
}

// Which frame to show once the list has been replaced.
//
// `followingLatest` is the user's own choice, recorded while the previous list
// was still in hand rather than inferred from an index afterwards. Somebody who
// left the map on the newest frame wants the newest frame, whatever the new
// list looks like; somebody who scrubbed back to a particular time wants that
// time.
function reselect(frames, shownTime, followingLatest) {
  if (!frames || frames.length === 0) return -1
  if (followingLatest) return frames.length - 1
  if (!isFinite(shownTime) || shownTime <= 0) return frames.length - 1
  return indexNearest(frames, shownTime)
}

// The next frame during playback, wrapping to the start at the end of the loop.
function nextIndex(frames, index) {
  if (!frames || frames.length === 0) return -1
  if (index >= frames.length - 1) return 0
  return Math.max(0, index + 1)
}

// An index that is safe to read from this list, whatever it was chosen against.
function clampIndex(frames, index) {
  if (!frames || frames.length === 0) return -1
  return Math.max(0, Math.min(frames.length - 1, index))
}
