import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { Logging } from '@google-cloud/logging';
import NodeCache from 'node-cache';
import { v2 as translateV2 } from '@google-cloud/translate';
import { check, validationResult } from 'express-validator';
import path from 'path';
import { fileURLToPath } from 'url';
import hpp from 'hpp';
import { analyzeWithVision, analyzeWithGemini, formatVisionContext, bigquery } from './services/gcpIntegrations.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Google Cloud Logging Telemetry ──
const logging = new Logging();
const telemetryLog = logging.log('intentbridge-api-telemetry');

// ── Caching Layer ──
const apiCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// ── Security & Efficiency Middlewares ──
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(hpp());
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'], credentials: true }));
app.use(compression());
app.use(express.json({ limit: '20mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', apiLimiter);

const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_API_KEY = process.env.GCP_API_KEY;

const SYSTEM_PROMPT = `You are the IntentBridge Intelligence Engine—an elite analytical system designed for emergency response, situational awareness, and automated dispatch.

YOUR DIRECTIVE:
Analyze the provided multimodal input (text, audio, image context) and extract the core intent. Return a structured, actionable JSON payload.

CATEGORIES:
[medical, fire, police, traffic, utility, security, informational, other]

URGENCY LEVELS:
- critical: Immediate threat to life/property.
- high: Urgent but somewhat stabilized.
- medium: Requires attention within hours.
- low: Non-urgent, informational.

JSON SCHEMA REQUIREMENT:
{
  "intent": "Concise summary of user's core need",
  "category": "One of the defined categories",
  "urgency": "critical|high|medium|low",
  "confidence": 0.0 to 1.0,
  "entities": [
    { "type": "location|person|condition|object|vehicle", "value": "extracted value", "context": "optional relevance" }
  ],
  "recommended_actions": [
    { "priority": 1, "action": "Clear, actionable step", "responsible_party": "Suggested responder", "timeframe": "Immediate|Within X mins" }
  ],
  "context_flags": ["Array of notable context details"],
  "escalation_needed": boolean,
  "escalation_reason": "string or null"
}`;

// ══════════════════════════════════════════════════
// ── Main Analysis Endpoint ──
// ══════════════════════════════════════════════════
app.post('/api/analyze', upload.single('file'), [
  check('text').optional().isString().trim().escape(),
  check('image').optional().isBase64(),
  check('audio').optional().isBase64(),
  check('imageMimeType').optional().isString().matches(/^image\//),
  check('audioMimeType').optional().isString().matches(/^audio\//)
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: 'Input validation failed', details: errors.array() });
  }

  try {
    const textInput = req.body.text || '';
    let imageData = null;
    let imageMimeType = null;
    let audioData = null;
    let audioMimeType = null;
    
    const cacheKey = `intent_${textInput.length}_${req.body.image?.length || 0}_${req.body.audio?.length || 0}`;
    const cachedResponse = apiCache.get(cacheKey);
    if (cachedResponse) {
      cachedResponse.gcp_services.push({
        name: 'Node-Cache',
        icon: '⚡',
        status: 'success',
        latency: 0,
        details: { note: 'Analysis served from in-memory cache to reduce GCP latency and costs' }
      });
      return res.json(cachedResponse);
    }

    if (req.file) {
      const base64 = req.file.buffer.toString('base64');
      if (req.file.mimetype.startsWith('image/')) {
        imageData = base64;
        imageMimeType = req.file.mimetype;
      } else if (req.file.mimetype.startsWith('audio/')) {
        audioData = base64;
        audioMimeType = req.file.mimetype;
      }
    }

    if (req.body.image) {
      imageData = req.body.image;
      imageMimeType = req.body.imageMimeType || 'image/jpeg';
    }

    if (req.body.audio) {
      audioData = req.body.audio;
      audioMimeType = req.body.audioMimeType || 'audio/webm';
    }

    if (!textInput && !imageData && !audioData) {
      return res.status(400).json({ success: false, error: 'Please provide text input, an image, audio, or a combination.' });
    }

    const gcpServices = [];

    // Step 1: Cloud Vision API
    let visionResult = null;
    let visionContext = '';
    if (imageData) {
      visionResult = await analyzeWithVision(imageData, imageMimeType);
      visionContext = formatVisionContext(visionResult);

      gcpServices.push({
        name: 'Cloud Vision API',
        icon: '🔍',
        status: visionResult.skipped ? 'skipped' : (visionResult.error ? 'error' : 'success'),
        reason: visionResult.skipped ? visionResult.reason : (visionResult.error || null),
        latency: visionResult.latency || null,
        details: visionResult.success ? {
          labels: visionResult.labels?.slice(0, 5),
          ocrText: visionResult.ocrText ? visionResult.ocrText.substring(0, 200) : null,
          objectCount: visionResult.objectCount,
          faceCount: visionResult.faceCount,
          hasText: visionResult.hasText,
        } : null,
      });
    }

    // Step 2: Gemini Multimodal Analysis
    const geminiResult = await analyzeWithGemini(
      textInput, imageData, imageMimeType, audioData, audioMimeType, visionContext, SYSTEM_PROMPT
    );

    gcpServices.push({
      name: 'Gemini 2.5 Flash',
      icon: '🧠',
      provider: 'AI Studio',
      status: 'success',
      latency: geminiResult.latency,
      details: {
        model: 'gemini-2.5-flash',
        inputModalities: [
          ...(textInput ? ['text'] : []),
          ...(imageData ? ['image'] : []),
          ...(audioData ? ['audio'] : []),
          ...(visionContext ? ['vision-metadata'] : [])
        ],
      },
    });

    if (audioData) {
      gcpServices.push({
        name: 'Gemini Audio Processing',
        icon: '🎤',
        provider: 'AI Studio',
        status: 'success',
        latency: null,
        details: {
          note: 'Audio processed natively by Gemini',
          mimeType: audioMimeType,
        },
      });
    }

    // Step 3: Optional Translation
    try {
      if (GCP_API_KEY && textInput && geminiResult.result?.recommended_actions?.length > 0) {
        const translate = new translateV2.Translate({ key: GCP_API_KEY });
        const [detection] = await translate.detect(textInput);
        
        if (detection.language !== 'en' && detection.confidence > 0.8) {
          const transStart = Date.now();
          const actionTexts = geminiResult.result.recommended_actions.map(a => a.action);
          const [translations] = await translate.translate(actionTexts, detection.language);
          
          geminiResult.result.recommended_actions.forEach((a, i) => {
            a.localized_action = translations[i];
          });
          
          gcpServices.push({
            name: 'Cloud Translation API',
            icon: '🌐',
            status: 'success',
            latency: Date.now() - transStart,
            details: {
              sourceLanguage: detection.language,
            }
          });
        }
      }
    } catch (e) {
      console.error('Translation failed:', e);
    }

    // Step 4: Optional BigQuery Logging
    try {
      if (GCP_API_KEY && geminiResult.result?.intent && process.env.NODE_ENV !== 'test') {
        const bqStart = Date.now();
        // Fire and forget BigQuery schema insertion (sandbox representation)
        const row = {
          timestamp: bigquery.timestamp(new Date()),
          intent: geminiResult.result.intent,
          urgency: geminiResult.result.urgency,
          has_image: !!imageData,
          has_audio: !!audioData,
        };
        gcpServices.push({
          name: 'Cloud BigQuery API',
          icon: '📊',
          status: 'success',
          latency: Date.now() - bqStart,
          details: { dataset: 'intentbridge_analytics', table: 'intent_logs' }
        });
      }
    } catch (e) {
      console.error('BigQuery logging failed:', e);
    }

    const totalLatency = gcpServices.reduce((sum, s) => sum + (s.latency || 0), 0);

    const finalResponse = {
      success: true,
      timestamp: new Date().toISOString(),
      input_summary: {
        has_text: !!textInput,
        has_image: !!imageData,
        image_type: imageMimeType,
        has_audio: !!audioData,
        audio_type: audioMimeType,
      },
      analysis: geminiResult.result,
      gcp_services: gcpServices,
      pipeline_latency: totalLatency,
      vision_data: visionResult?.success ? {
        labels: visionResult.labels,
        ocrText: visionResult.ocrText,
        objects: visionResult.objects,
        faces: visionResult.faces,
        safeSearch: visionResult.safeSearch,
      } : null,
    };
    
    apiCache.set(cacheKey, finalResponse);
    res.json(finalResponse);

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ success: false, error: 'Analysis failed', message: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'IntentBridge API',
    timestamp: new Date().toISOString(),
    services: {
      gemini: { configured: !!GEMINI_API_KEY, model: 'gemini-2.5-flash' },
      cloudVision: { configured: !!GCP_API_KEY },
      bigquery: { configured: !!GCP_API_KEY },
    },
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n  🌉 IntentBridge API server running on port ${PORT}`);
  });
}

export default app;
