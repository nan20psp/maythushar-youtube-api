const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

// Rate limiting for Render Pro
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(limiter);

// Cache directory
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Clean old cache files every hour
setInterval(() => {
  fs.readdir(CACHE_DIR, (err, files) => {
    if (err) return;
    
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(CACHE_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err) return;
        
        // Delete files older than 6 hours
        if (now - stat.mtime.getTime() > 6 * 60 * 60 * 1000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 60 * 60 * 1000);

// Helper functions
function extractVideoId(url) {
  if (!url) return null;
  
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

function sanitizeFilename(filename) {
  return filename.replace(/[^\w\s-]/gi, '').substring(0, 100);
}

// Routes
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MayThuShar Music YouTube API',
    version: '2.0.0',
    endpoints: {
      info: '/api/info?url=YOUTUBE_URL',
      audio: '/api/audio?url=YOUTUBE_URL&quality=high',
      video: '/api/video?url=YOUTUBE_URL&quality=medium',
      search: '/api/search?q=QUERY&limit=10',
      formats: '/api/formats?url=YOUTUBE_URL'
    },
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    platform: process.platform
  });
});

// Get video info
app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(videoId);
    
    // Get audio formats
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    const videoFormats = ytdl.filterFormats(info.formats, 'videoonly');
    
    res.json({
      success: true,
      videoId,
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      durationFormatted: formatDuration(info.videoDetails.lengthSeconds),
      thumbnail: info.videoDetails.thumbnails.sort((a, b) => b.width - a.width)[0]?.url,
      channel: info.videoDetails.author.name,
      viewCount: info.videoDetails.viewCount,
      audioFormats: audioFormats.map(f => ({
        itag: f.itag,
        quality: f.audioQuality || 'unknown',
        bitrate: f.audioBitrate,
        size: f.contentLength ? formatBytes(f.contentLength) : 'unknown'
      })),
      videoFormats: videoFormats.slice(0, 5).map(f => ({
        itag: f.itag,
        quality: f.qualityLabel,
        width: f.width,
        height: f.height,
        fps: f.fps,
        size: f.contentLength ? formatBytes(f.contentLength) : 'unknown'
      }))
    });

  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ 
      error: 'Failed to get video info',
      message: error.message 
    });
  }
});

// Download audio with quality options
app.get('/api/audio', async (req, res) => {
  try {
    const { url, quality = 'high', bitrate = '192' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(videoId);
    const title = sanitizeFilename(info.videoDetails.title);
    
    // Cache key
    const cacheKey = `audio_${videoId}_${quality}_${bitrate}`;
    const cacheFile = path.join(CACHE_DIR, `${cacheKey}.mp3`);
    
    // Check cache
    if (fs.existsSync(cacheFile)) {
      return res.download(cacheFile, `${title}.mp3`);
    }

    // Determine quality settings
    let ytdlQuality = 'highestaudio';
    if (quality === 'low') ytdlQuality = 'lowestaudio';
    else if (quality === 'medium') ytdlQuality = 'highestaudio';

    res.header('Content-Type', 'audio/mpeg');
    res.header('Content-Disposition', `attachment; filename="${title}.mp3"`);
    
    // Create transform stream for MP3 conversion
    const audioStream = ytdl(videoId, {
      filter: 'audioonly',
      quality: ytdlQuality,
    });

    // Pipe through ffmpeg for MP3 conversion
    const ffmpegStream = ffmpeg(audioStream)
      .audioCodec('libmp3lame')
      .audioBitrate(`${bitrate}k`)
      .format('mp3')
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Audio processing failed' });
        }
      });

    // Create write stream for caching
    const fileStream = fs.createWriteStream(cacheFile);
    
    // Pipe to both response and cache
    ffmpegStream.pipe(res);
    ffmpegStream.pipe(fileStream);

    // Clean up cache file on error
    ffmpegStream.on('end', () => {
      fileStream.end();
    });

    ffmpegStream.on('error', () => {
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile);
      }
    });

  } catch (error) {
    console.error('Audio download error:', error);
    res.status(500).json({ 
      error: 'Audio download failed',
      message: error.message 
    });
  }
});

// Download video
app.get('/api/video', async (req, res) => {
  try {
    const { url, quality = '360p' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(videoId);
    const title = sanitizeFilename(info.videoDetails.title);
    
    // Determine format based on quality
    let format;
    if (quality === '144p') format = ytdl.chooseFormat(info.formats, { quality: '144p' });
    else if (quality === '240p') format = ytdl.chooseFormat(info.formats, { quality: '240p' });
    else if (quality === '360p') format = ytdl.chooseFormat(info.formats, { quality: '360p' });
    else if (quality === '480p') format = ytdl.chooseFormat(info.formats, { quality: '480p' });
    else if (quality === '720p') format = ytdl.chooseFormat(info.formats, { quality: '720p' });
    else if (quality === '1080p') format = ytdl.chooseFormat(info.formats, { quality: '1080p' });
    else format = ytdl.chooseFormat(info.formats, { quality: 'highest' });

    if (!format) {
      return res.status(404).json({ error: 'No suitable format found' });
    }

    res.header('Content-Type', 'video/mp4');
    res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
    
    ytdl(videoId, { format }).pipe(res);

  } catch (error) {
    console.error('Video download error:', error);
    res.status(500).json({ 
      error: 'Video download failed',
      message: error.message 
    });
  }
});

// Search videos
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query is required (min 2 chars)' });
    }

    // Using YouTube's oembed as a simple search method
    // Note: For production, use YouTube Data API v3 with API key
    const searchUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=json`;
    
    // This is a placeholder - implement proper search with youtube-data-api
    res.json({
      success: true,
      query: q,
      results: [],
      message: 'Search requires YouTube Data API v3 key'
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get all available formats
app.get('/api/formats', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(videoId);
    
    const formats = info.formats.map(f => ({
      itag: f.itag,
      mimeType: f.mimeType,
      quality: f.qualityLabel || f.audioQuality,
      hasVideo: f.hasVideo,
      hasAudio: f.hasAudio,
      width: f.width,
      height: f.height,
      fps: f.fps,
      bitrate: f.bitrate,
      audioBitrate: f.audioBitrate,
      size: f.contentLength ? formatBytes(f.contentLength) : 'unknown',
      url: f.url
    }));

    res.json({
      success: true,
      videoId,
      title: info.videoDetails.title,
      formats: formats
    });

  } catch (error) {
    console.error('Formats error:', error);
    res.status(500).json({ error: 'Failed to get formats' });
  }
});

// Studio voice quality (premium feature)
app.get('/api/studio', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(videoId);
    const title = sanitizeFilename(info.videoDetails.title);
    
    res.header('Content-Type', 'audio/mpeg');
    res.header('Content-Disposition', `attachment; filename="${title}_studio.mp3"`);
    
    // High quality audio with enhancements
    const audioStream = ytdl(videoId, {
      filter: 'audioonly',
      quality: 'highestaudio',
    });

    // Enhanced audio processing
    ffmpeg(audioStream)
      .audioCodec('libmp3lame')
      .audioBitrate('320k')
      .audioFilters([
        'volume=1.5',
        'aresample=48000',
        'highpass=f=80',
        'lowpass=f=16000',
        'aresample=async=1000'
      ])
      .format('mp3')
      .on('error', (err) => {
        console.error('Studio audio error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Studio audio processing failed' });
        }
      })
      .pipe(res);

  } catch (error) {
    console.error('Studio audio error:', error);
    res.status(500).json({ error: 'Studio audio download failed' });
  }
});

// Utility functions
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║     MayThuShar Music YouTube API          ║
║     Server running on port ${PORT}            ║
║     Render Pro Plan Ready                 ║
╚═══════════════════════════════════════════╝
  `);
});
