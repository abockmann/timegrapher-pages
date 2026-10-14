

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
    this.setPlotParams();
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

  drawGrid() {
    // Draw horizontal lines whose spacing represent 1 sec/day when the beat plot has traveled across the entire canvas witdh.
    const secPerDayPerGridLine = 5;
    const deltaCoordYCanvas = secPerDayPerGridLine * this.canvas.height * (this.xMaxSubdiv * (1 / 3600 / 24)) / (1 / this.bps / 2**this.ySubdivisions) ; // the spacing in canvas coordinates between horizontal lines

    for (let yCanvas = 0; yCanvas < this.canvas.height; yCanvas += deltaCoordYCanvas) {
      this.ctx.setLineDash([5, 15]);
      this.ctx.lineWidth = 1;
      this.ctx.strokeStyle = this.gridColor;
      this.ctx.beginPath();
      this.ctx.moveTo(0, yCanvas);
      this.ctx.lineTo(this.canvas.width, yCanvas);
      this.ctx.stroke();
    }
  }

  plot(beatSampleIndexArray) {
    this.wipeScreen();
    this.drawGrid();
    beatSampleIndexArray.forEach(i => {
      // compute canvas coordinates
      const xCanvas = this.canvas.width * ((i / this.sampleRate) % this.xMaxSubdiv) / this.xMaxSubdiv; // x coordinate as fraction of plot space (x pointing to the right)
      const yCanvas = this.canvas.height * ((i % this.spb) % this.spbSubdiv) / this.spbSubdiv; // y coordinate as fraction of plot space (y pointing downwards)
      
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

