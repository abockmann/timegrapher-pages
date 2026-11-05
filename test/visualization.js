

function amplitudeToSamples(angleDeg, bps, sampleRate, liftAngleDeg) {
  return (2 * sampleRate / (Math.PI * bps)) * Math.asin(liftAngleDeg / (2 * angleDeg))
}


class beatPlot {
  // A beat plot that plots the beat sample index (y) against the beat sample index (x), so that the points are aligned vertically at each beat, and the y value is the number of samples since the last beat. This allows to visualize the consistency of the beat intervals, and to see if there are any outliers or patterns in the beat timing.
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.xMaxSec = 80; // Max x-axis limit in seconds
    this.pointSize = 3; // Size of the square points
    this.pointColor = '#f5f5dc'; // Cream white for points
    this.gridColor = '#232323'; // Dark gray for grid lines

    // Slope fan & drag state
    this.slopeFanVisible = false;
    this.dragOffsetX = 0; // accumulated drag offset in canvas pixels (x)
    this.dragOffsetY = 0; // accumulated drag offset in canvas pixels (y)
    this.onDrag = null;   // callback set externally to trigger a redraw

    this.setPlotParams();
    this._setupTouchHandlers();
  }

  wipeScreen() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  setPlotParams(sampleRate=48000, beatRate=21600, xSubdivisions=2, ySubdivisions=2) {
    this.sampleRate = sampleRate;
    this.beatRate = beatRate;
    this.xSubdivisions = xSubdivisions;
    this.ySubdivisions = ySubdivisions;
    this.bps = beatRate/3600;
    this.spb = this.sampleRate / this.bps; // samples per beat
    this.spbSubdiv = this.spb / 2**this.ySubdivisions; // samples per subdivision
    this.xMaxSubdiv = this.xMaxSec / 2**this.xSubdivisions; // maximum x value in seconds per subdivision
  }

  getXMaxSecSubdiv() {
    return this.xMaxSubdiv
  }

  _fanParams() {
    // Returns the shared spacing parameters used by both drawGrid and drawSlopeFan.
    const H = this.canvas.height;
    const pixPerSecPerDay = H * this.xMaxSubdiv * this.bps * (2 ** this.ySubdivisions) / 86400;
    const minSpacingPx = 28;
    const candidates = [0.5, 1, 2, 5, 10, 20, 30];
    let interval = candidates[candidates.length - 1];
    for (const c of candidates) {
      if (c * pixPerSecPerDay >= minSpacingPx) { interval = c; break; }
    }
    return { pixPerSecPerDay, interval };
  }

  drawGrid() {
    const H = this.canvas.height;
    const W = this.canvas.width;
    const { pixPerSecPerDay, interval } = this._fanParams();
    const stepPx = interval * pixPerSecPerDay;
    const cy = H / 2;

    this.ctx.setLineDash([5, 15]);
    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = this.gridColor;

    // Iterate over all grid positions aligned with cy, wrapping to fill the canvas.
    // Start at cy % H and step both upward and downward.
    const origin = ((cy % H) + H) % H;
    for (let offset = 0; offset < H; offset += stepPx) {
      for (const base of [origin + offset, origin - offset]) {
        const y = ((base % H) + H) % H;
        // Avoid drawing the same line twice when offset is 0
        if (offset > 0 || base === origin) {
          this.ctx.beginPath();
          this.ctx.moveTo(0, y);
          this.ctx.lineTo(W, y);
          this.ctx.stroke();
        }
      }
    }
  }

  drawSlopeFan() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cy = H / 2;
    const { pixPerSecPerDay, interval } = this._fanParams();
    const rMax = (H / 3) / pixPerSecPerDay;

    this.ctx.save();
    this.ctx.lineWidth = 1;
    this.ctx.font = '0.7rem sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';

    // Zero-rate reference line (slightly more prominent)
    this.ctx.setLineDash([5, 5]);
    this.ctx.strokeStyle = 'rgba(100, 180, 255, 0.65)';
    this.ctx.fillStyle   = 'rgba(100, 180, 255, 0.85)';
    this.ctx.beginPath();
    this.ctx.moveTo(0, cy);
    this.ctx.lineTo(W, cy);
    this.ctx.stroke();
    this.ctx.fillText('0', W - 4, cy);

    // Non-zero slope lines
    this.ctx.setLineDash([3, 8]);
    this.ctx.strokeStyle = 'rgba(100, 180, 255, 0.35)';
    this.ctx.fillStyle   = 'rgba(100, 180, 255, 0.65)';

    for (let r = interval; r <= rMax + 0.001; r += interval) {
      for (const sign of [1, -1]) {
        const rate   = sign * r;
        const yRight = cy + rate * pixPerSecPerDay;
        if (yRight < -2 || yRight > H + 2) continue;

        this.ctx.beginPath();
        this.ctx.moveTo(0, cy);
        this.ctx.lineTo(W, yRight);
        this.ctx.stroke();

        // Format label: integer if whole, one decimal otherwise
        const label = Number.isInteger(rate)
          ? (rate > 0 ? `+${rate}` : `${rate}`)
          : (rate > 0 ? `+${rate.toFixed(1)}` : `${rate.toFixed(1)}`);
        this.ctx.fillText(label, W - 4, yRight);
      }
    }

    this.ctx.restore();
  }

  _setupTouchHandlers() {
    let lastTouchX = 0;
    let lastTouchY = 0;
    let dragging   = false;

    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.slopeFanVisible) return;
      e.preventDefault();
      dragging    = true;
      lastTouchX  = e.touches[0].clientX;
      lastTouchY  = e.touches[0].clientY;
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      if (!this.slopeFanVisible || !dragging) return;
      e.preventDefault();

      // Scale CSS-pixel delta to canvas-pixel delta
      const rect   = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width  / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const dx = (e.touches[0].clientX - lastTouchX) * scaleX;
      const dy = (e.touches[0].clientY - lastTouchY) * scaleY;
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;

      // Accumulate, keeping in [0, W) and [0, H) to avoid float drift
      const W = this.canvas.width;
      const H = this.canvas.height;
      this.dragOffsetX = ((this.dragOffsetX + dx) % W + W) % W;
      this.dragOffsetY = ((this.dragOffsetY + dy) % H + H) % H;

      if (this.onDrag) this.onDrag();
    }, { passive: false });

    this.canvas.addEventListener('touchend', () => {
      dragging = false;
    });

    // Mouse equivalents (desktop testing / non-touch use)
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.slopeFanVisible) return;
      e.preventDefault();
      dragging   = true;
      lastTouchX = e.clientX;
      lastTouchY = e.clientY;
      this.canvas.style.cursor = 'grabbing';
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.slopeFanVisible || !dragging) return;

      const rect   = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width  / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const dx = (e.clientX - lastTouchX) * scaleX;
      const dy = (e.clientY - lastTouchY) * scaleY;
      lastTouchX = e.clientX;
      lastTouchY = e.clientY;

      const W = this.canvas.width;
      const H = this.canvas.height;
      this.dragOffsetX = ((this.dragOffsetX + dx) % W + W) % W;
      this.dragOffsetY = ((this.dragOffsetY + dy) % H + H) % H;

      if (this.onDrag) this.onDrag();
    });

    // End drag on mouseup anywhere in the document (handles leaving the canvas mid-drag)
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        this.canvas.style.cursor = this.slopeFanVisible ? 'grab' : '';
      }
    });

    // Show grab cursor when fan is on and mouse enters the canvas
    this.canvas.addEventListener('mouseenter', () => {
      if (this.slopeFanVisible) this.canvas.style.cursor = 'grab';
    });
    this.canvas.addEventListener('mouseleave', () => {
      if (!dragging) this.canvas.style.cursor = '';
    });
  }

  plot(beatSampleIndexArray) {
    this.wipeScreen();
    this.drawGrid();
    if (this.slopeFanVisible) this.drawSlopeFan();

    const W  = this.canvas.width;
    const H  = this.canvas.height;
    const ox = this.dragOffsetX;
    const oy = this.dragOffsetY;

    beatSampleIndexArray.forEach(i => {
      // compute canvas coordinates, incorporating drag offsets with correct wraparound
      const xCanvas = (W * ((i / this.sampleRate) % this.xMaxSubdiv) / this.xMaxSubdiv + ox) % W;
      const yCanvas = (H * ((i % this.spb) % this.spbSubdiv) / this.spbSubdiv + oy) % H;

      // draw a square for the point
      this.ctx.fillStyle = this.pointColor;
      this.ctx.fillRect(xCanvas - this.pointSize/2, yCanvas - this.pointSize/2, this.pointSize, this.pointSize);
    })
  }
}




class WaveformPlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // Default styling options
    this.ticColor = '#003cb365';
    this.tocColor = '#0065b365';
    this.gridColor = '#22222';
    this.lineWidth = 1;
    this.showGrid = false;
    
    // Auto-scaling options
    this.autoScale = true;
    this.padding = 0; // pixels padding around the plot
  }
  
  // Clear the canvas
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  

  
  // Main plot method
  plot(ticProfile, tocProfile, sampleRate, liftAngle, bps, amplitude) {
    if (!ticProfile || ticProfile.length === 0 || !tocProfile || tocProfile.length === 0) {
      console.warn("Empty or invalid waveform array");
      return;
    }
    
    
    // Clear canvas
    this.clear();
    
    // Calculate scaling factors
    const plotWidth = this.canvas.width - 2 * this.padding;
    const plotHeight = this.canvas.height - 2 * this.padding;
    
    let minY, maxY;

    maxY = Math.max(Math.max(...ticProfile), Math.max(...tocProfile));
    minY = 0;
    
    // Add some padding to the Y range
    const yRange = maxY - minY;
    const yPadding = yRange * 0.2; // 20% padding
    minY -= yPadding;
    maxY += yPadding;

    // Avoid division by zero
    if (maxY === minY) {
      maxY = minY + 1;
    }
    
    const wn = ticProfile.length;
    // decimate the waveform array to not be of finer resolution than the plot window
    const n_dec = Math.floor(wn / plotWidth);

    const xScale = plotWidth / (wn - 1);
    const yScale = plotHeight / (maxY - minY);
    


    // Draw the tic profile
    this.ctx.strokeStyle = this.ticColor;
    this.ctx.lineWidth = 0;
    this.ctx.beginPath();
    
    for (let i = 0; i < wn; i+=n_dec) {
      const x = this.padding + i * xScale;
      const y = this.canvas.height - this.padding - (ticProfile[i]) * 0.5*yScale - 0.5*this.canvas.height;
      
      if (i === 0) {
        this.ctx.moveTo(x, this.canvas.height - this.padding - 0.5*this.canvas.height);
      } else {
        this.ctx.lineTo(x, y);
      }

      // last iteration
      if (i + n_dec >= wn) {
        this.ctx.lineTo(x, this.canvas.height - this.padding - 0.5*this.canvas.height); // to the middle of the canvas
      }
    }

    this.ctx.save();
    this.ctx.clip();
    this.ctx.fillStyle=this.ticColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();


    // Draw the toc profile
    this.ctx.strokeStyle = this.tocColor;
    this.ctx.lineWidth = 0;
    this.ctx.beginPath();
    
    for (let i = 0; i < wn; i+=n_dec) {
      const x = this.padding + i * xScale;
      const y = this.canvas.height - this.padding + (tocProfile[i]) * 0.5*yScale - 0.5*this.canvas.height;
      
      if (i === 0) {
        this.ctx.moveTo(x, this.canvas.height - this.padding - 0.5*this.canvas.height);
      } else {
        this.ctx.lineTo(x, y);
      }

      // last iteration
      if (i + n_dec >= wn) {
        this.ctx.lineTo(x, this.canvas.height - this.padding - 0.5*this.canvas.height); // to the middle of the canvas
      }
    }



    this.ctx.save();
    this.ctx.clip();
    this.ctx.fillStyle=this.tocColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();


  

    // draw amplitude marker lines
    const markersDeg = [100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350];
    const markersSampl = markersDeg.map(ang => Math.round(amplitudeToSamples(ang, bps, sampleRate, liftAngle))); // amplitudeToSamples(angleDeg, bps, sampleRate, liftAngleDeg) 
    
    this.ctx.setLineDash([5, 5]);
    
    for (let i = 0; i < markersSampl.length; i++) {
      const x = markersSampl[i] * xScale;
      if (markersDeg[i] % 100 === 0) {
        this.ctx.strokeStyle = '#a1a1a1';
        this.ctx.fillStyle = '#a1a1a1';
        this.ctx.font = "0.8pc sans-serif";
        this.ctx.fillText(markersDeg[i], x+0.01*this.canvas.width, 0.1*this.canvas.height);
      } else {
        this.ctx.strokeStyle = '#444444';
      }
      
      this.ctx.beginPath();
      this.ctx.moveTo(x, this.canvas.height);
      this.ctx.lineTo(x, 0);
      this.ctx.stroke();
    }

  // Draw red vertical line for computed amplitude
  if (amplitude && amplitude > 0) {
    const amplitudeSamples = Math.round(amplitudeToSamples(amplitude, bps, sampleRate, liftAngle));
    const ampX = amplitudeSamples * xScale;
    
    if (ampX >= 0 && ampX <= this.canvas.width) {
      this.ctx.setLineDash([]);  // Solid line
      this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)';  // Red with 40% opacity
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(ampX, 0);
      this.ctx.lineTo(ampX, this.canvas.height);
      this.ctx.stroke();
      this.ctx.lineWidth = 1;
    }
  }
  }
}

