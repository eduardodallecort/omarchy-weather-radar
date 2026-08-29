import QtQuick
import "../lib/RadarModel.js" as RadarModel

// Reads RainViewer's coverage mask to answer one question: does a ground radar
// reach the configured location?
//
// Large parts of the world have none, and an empty map there reads as a broken
// plugin unless it says so. The mask is transparent where coverage exists, so
// the answer is one pixel — but getting at a pixel means drawing the image,
// which is why this is a Canvas rather than a plain Image.
Canvas {
  id: root

  // The mask tile to sample, centred on the location. Empty until there is one.
  property string source: ""

  signal resolved(bool covered)

  width: 256
  height: 256

  // Zero opacity rather than `visible: false`. An invisible item is never
  // rendered, and a Canvas that is never rendered never paints, so it would
  // have nothing to read.
  opacity: 0
  z: -1

  // The one network stream this plugin does not bound the decode of, and the
  // only way to read the mask that works. Context2D reads pixels from an image
  // it loaded itself; handed an Image item instead — which would carry a
  // `sourceSize` — drawImage produces nothing to read, and every location comes
  // back reported as covered. Measured, against five places on and off the
  // radar network.
  //
  // What bounds it instead: the URL is built from the manifest's host, which
  // parseManifest now requires to be an https origin, and the manifest itself
  // arrives over TLS from RainViewer. See test/streams.test.js for the
  // inventory this exception is recorded in.
  //
  // Driven explicitly rather than by the load signal alone. A probe begun
  // against a closed panel queues a repaint that never arrives, and an image
  // already in Qt's cache does not re-emit imageLoaded to restart one.
  function probe() {
    if (source === "") return
    if (isImageLoaded(source)) requestPaint()
    else loadImage(source)
  }

  onSourceChanged: probe()
  onImageLoaded: requestPaint()

  onPaint: {
    if (source === "" || !isImageLoaded(source)) return
    var ctx = getContext("2d")
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(source, 0, 0, width, height)
    var pixels = ctx.getImageData(0, 0, width, height).data
    root.resolved(RadarModel.hasCoverageAtCenter(pixels, width))
  }
}
