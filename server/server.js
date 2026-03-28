import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_API_KEY = process.env.GCP_API_KEY;

// ── System Prompt ──
const SYSTEM_PROMPT = `You are an intent extraction engine for a universal bridge system called IntentBridge.
Your purpose is to analyze any kind of input — text descriptions, transcribed speech, audio recordings, images of documents, medical records, accident scenes, weather conditions, traffic situations, news articles, or any real-world scenario — and convert them into structured, actionable intelligence.

You may receive:
- Text input from the user
- Audio recordings (you can hear tone, urgency, emotion, background sounds)
- Images (you can see visual content)
- Pre-processed metadata from Google Cloud Vision API (labels, OCR text, detected objects, faces)

When Cloud Vision metadata is provided, USE it to enrich your analysis — it provides verified structural data about the image.
When audio is provided, pay attention to tone of voice, urgency in speech patterns, background sounds, and emotional state.

You MUST respond with ONLY valid JSON (no markdown fencing, no explanation) in this exact format:
{
  "intent": "A clear, concise description of the primary intent or situation",
  "category": "One of: medical, emergency, legal, financial, environmental, infrastructure, social, informational, personal, logistics",
  "urgency": "One of: low, medium, high, critical",
  "confidence": A number between 0 and 1 representing your confidence,
  "entities": [
    { "type": "person|place|condition|object|date|organization|quantity|event", "value": "extracted value", "relevance": "why this entity matters" }
  ],
  "recommended_actions": [
    { "priority": 1, "action": "Concrete actionable step", "responsible_party": "Who should do this", "timeframe": "When this should happen" }
  ],
  "context_flags": ["any relevant contextual warnings or notes"],
  "escalation_needed": true or false,
  "escalation_reason": "Why escalation is needed, or null"
}

URGENCY CLASSIFICATION GUIDE:
- "critical": Life-threatening situations, active emergencies, immediate danger to persons, severe medical conditions (heart attack, stroke, severe bleeding, unconsciousness)
- "high": Time-sensitive matters, significant financial/legal deadlines, deteriorating medical conditions, infrastructure failures, severe weather warnings
- "medium": Important but not immediately time-critical situations, routine medical appointments, moderate complaints, planning needs
- "low": Informational queries, general planning, curiosity, non-urgent documentation

Be thorough in entity extraction. Look for implicit entities (dates, quantities, people mentioned indirectly).
For images: describe what you see and extract intent from visual context.
For audio: note the speaker's emotional state, urgency level from tone, and any background sounds.
Always provide at least 2-3 recommended actions, ordered by priority.`;

// ══════════════════════════════════════════════════
// ── Google Cloud Vision API ──
// ══════════════════════════════════════════════════
async function analyzeWithVision(base64Image, mimeType) {
  if (!GCP_API_KEY) {
    return { skipped: true, reason: 'No GCP_API_KEY configured' };
  }

  const startTime = Date.now();

  try {
    const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${GCP_API_KEY}`;

    const requestBody = {
      requests: [
        {
          image: { content: base64Image },
          features: [
            { type: 'LABEL_DETECTION', maxResults: 10 },
            { type: 'TEXT_DETECTION', maxResults: 5 },
            { type: 'OBJECT_LOCALIZATION', maxResults: 10 },
            { type: 'FACE_DETECTION', maxResults: 5 },
            { type: 'SAFE_SEARCH_DETECTION' },
            { type: 'IMAGE_PROPERTIES', maxResults: 3 },
          ],
        },
      ],
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    const latency = Date.now() - startTime;

    if (data.error) {
      return {
        skipped: false,
        error: data.error.message,
        latency,
      };
    }

    const result = data.responses?.[0] || {};

    // Extract structured results
    const labels = (result.labelAnnotations || []).map(l => ({
      description: l.description,
      score: Math.round(l.score * 100) / 100,
    }));

    const textAnnotations = result.textAnnotations || [];
    const ocrText = textAnnotations.length > 0 ? textAnnotations[0].description : null;

    const objects = (result.localizedObjectAnnotations || []).map(o => ({
      name: o.name,
      score: Math.round(o.score * 100) / 100,
    }));

    const faces = (result.faceAnnotations || []).map(f => ({
      joy: f.joyLikelihood,
      sorrow: f.sorrowLikelihood,
      anger: f.angerLikelihood,
      surprise: f.surpriseLikelihood,
      headwear: f.headwearLikelihood,
    }));

    const safeSearch = result.safeSearchAnnotation || null;

    return {
      skipped: false,
      success: true,
      latency,
      labels,
      ocrText,
      objects,
      faces,
      safeSearch,
      labelCount: labels.length,
      objectCount: objects.length,
      faceCount: faces.length,
      hasText: !!ocrText,
    };
  } catch (error) {
    return {
      skipped: false,
      error: error.message,
      latency: Date.now() - startTime,
    };
  }
}

// Format Vision results as context for Gemini
function formatVisionContext(visionResult) {
  if (!visionResult || visionResult.skipped || visionResult.error) return '';

  const parts = ['[Cloud Vision API Analysis]:'];

  if (visionResult.labels.length > 0) {
    parts.push(`Labels detected: ${visionResult.labels.map(l => `${l.description} (${(l.score * 100).toFixed(0)}%)`).join(', ')}`);
  }

  if (visionResult.ocrText) {
    parts.push(`OCR Text found in image:\n"${visionResult.ocrText}"`);
  }

  if (visionResult.objects.length > 0) {
    parts.push(`Objects detected: ${visionResult.objects.map(o => `${o.name} (${(o.score * 100).toFixed(0)}%)`).join(', ')}`);
  }

  if (visionResult.faces.length > 0) {
    parts.push(`Faces detected: ${visionResult.faceCount}. Emotions: ${visionResult.faces.map(f =>
      `joy=${f.joy}, sorrow=${f.sorrow}, anger=${f.anger}, surprise=${f.surprise}`
    ).join('; ')}`);
  }

  if (visionResult.safeSearch) {
    const ss = visionResult.safeSearch;
    parts.push(`SafeSearch: adult=${ss.adult}, violence=${ss.violence}, medical=${ss.medical}`);
  }

  return parts.join('\n');
}

// ══════════════════════════════════════════════════
// ── Gemini Multimodal Analysis ──
// ══════════════════════════════════════════════════
async function analyzeWithGemini(textInput, imageData, imageMimeType, audioData, audioMimeType, visionContext) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const startTime = Date.now();

  const contents = [];

  // Add text + vision context
  const textParts = [];
  if (textInput) {
    textParts.push(textInput);
  }
  if (visionContext) {
    textParts.push(visionContext);
  }
  if (textParts.length > 0) {
    contents.push({ text: `Analyze the following input and extract structured intent:\n\n${textParts.join('\n\n')}` });
  }

  // Add image as inline data
  if (imageData) {
    contents.push({
      inlineData: {
        mimeType: imageMimeType || 'image/jpeg',
        data: imageData,
      },
    });
    if (!textInput && !visionContext) {
      contents.push({ text: 'Analyze this image and extract structured intent. What situation does it depict? What actions should be taken?' });
    }
  }

  // Add audio as inline data
  if (audioData) {
    contents.push({
      inlineData: {
        mimeType: audioMimeType || 'audio/webm',
        data: audioData,
      },
    });
    if (!textInput && !imageData) {
      contents.push({ text: 'Listen to this audio recording and extract structured intent. Pay attention to tone of voice, urgency, emotion, and background sounds.' });
    }
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.2,
    },
  });

  const latency = Date.now() - startTime;
  const rawText = response.text.trim();

  // Strip markdown code fencing
  let jsonText = rawText;
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    return { result: JSON.parse(jsonText), latency };
  } catch {
    return {
      result: {
        intent: 'Analysis completed',
        category: 'informational',
        urgency: 'low',
        confidence: 0.5,
        entities: [],
        recommended_actions: [{ priority: 1, action: 'Review raw AI response', responsible_party: 'User', timeframe: 'Now' }],
        context_flags: ['JSON parsing failed — raw response included'],
        escalation_needed: false,
        escalation_reason: null,
        _raw_response: rawText,
      },
      latency,
    };
  }
}

// ══════════════════════════════════════════════════
// ── Main Analysis Endpoint ──
// ══════════════════════════════════════════════════
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const textInput = req.body.text || '';
    let imageData = null;
    let imageMimeType = null;
    let audioData = null;
    let audioMimeType = null;

    // Handle file upload via multipart form
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

    // Handle base64 image in JSON body
    if (req.body.image) {
      imageData = req.body.image;
      imageMimeType = req.body.imageMimeType || 'image/jpeg';
    }

    // Handle base64 audio in JSON body
    if (req.body.audio) {
      audioData = req.body.audio;
      audioMimeType = req.body.audioMimeType || 'audio/webm';
    }

    if (!textInput && !imageData && !audioData) {
      return res.status(400).json({ error: 'Please provide text input, an image, audio, or a combination.' });
    }

    // ── GCP Service Pipeline ──
    const gcpServices = [];

    // Step 1: Cloud Vision API (if image provided)
    let visionResult = null;
    let visionContext = '';
    if (imageData) {
      console.log('  🔍 Running Cloud Vision API...');
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

    // Step 2: Gemini Multimodal Analysis (AI Studio)
    console.log('  🧠 Running Gemini 2.5 Flash analysis...');
    const geminiResult = await analyzeWithGemini(
      textInput, imageData, imageMimeType, audioData, audioMimeType, visionContext
    );

    const geminiService = {
      name: 'Gemini 2.5 Flash',
      icon: '🧠',
      provider: 'AI Studio',
      status: 'success',
      latency: geminiResult.latency,
      details: {
        model: 'gemini-2.5-flash',
        inputModalities: [],
      },
    };
    if (textInput) geminiService.details.inputModalities.push('text');
    if (imageData) geminiService.details.inputModalities.push('image');
    if (audioData) geminiService.details.inputModalities.push('audio');
    if (visionContext) geminiService.details.inputModalities.push('vision-metadata');
    gcpServices.push(geminiService);

    // Step 3: Note audio processing by Gemini
    if (audioData) {
      gcpServices.push({
        name: 'Gemini Audio Processing',
        icon: '🎤',
        provider: 'AI Studio',
        status: 'success',
        latency: null, // included in Gemini latency
        details: {
          note: 'Audio processed natively by Gemini — tone, urgency, and emotion analysis included',
          mimeType: audioMimeType,
        },
      });
    }

    // Show upgrade paths for services not used
    if (!GCP_API_KEY && imageData) {
      gcpServices.push({
        name: 'Cloud Vision API',
        icon: '🔍',
        status: 'skipped',
        reason: 'No GCP_API_KEY configured — add to .env to enable',
      });
    }

    gcpServices.push({
      name: 'Cloud Speech-to-Text',
      icon: '🗣️',
      status: 'available',
      reason: 'Upgrade path — dedicated transcription with Chirp 3 model',
    });

    gcpServices.push({
      name: 'Cloud Storage',
      icon: '☁️',
      status: 'available',
      reason: 'Upgrade path — persistent file staging for large media',
    });

    gcpServices.push({
      name: 'Cloud Run',
      icon: '🚀',
      status: 'available',
      reason: 'Upgrade path — serverless auto-scaling deployment',
    });

    // ── Response ──
    const totalLatency = gcpServices
      .filter(s => s.latency)
      .reduce((sum, s) => sum + s.latency, 0);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      input_summary: {
        has_text: !!textInput,
        text_length: textInput.length,
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
    });

    console.log(`  ✅ Analysis complete — ${gcpServices.filter(s => s.status === 'success').length} services used, ${totalLatency}ms total\n`);

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Analysis failed',
      message: error.message,
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'IntentBridge API',
    timestamp: new Date().toISOString(),
    services: {
      gemini: { configured: !!GEMINI_API_KEY, model: 'gemini-2.5-flash' },
      cloudVision: { configured: !!GCP_API_KEY },
      cloudSpeech: { configured: false, note: 'Upgrade path available' },
      cloudStorage: { configured: false, note: 'Upgrade path available' },
    },
  });
});

app.listen(PORT, () => {
  console.log(`\n  🌉 IntentBridge API server running on http://localhost:${PORT}`);
  console.log(`  📡 POST /api/analyze — Multimodal intent extraction`);
  console.log(`  💚 GET  /api/health  — Health check`);
  console.log(`\n  GCP Services:`);
  console.log(`  ${GEMINI_API_KEY ? '✅' : '❌'} Gemini 2.5 Flash (AI Studio)`);
  console.log(`  ${GCP_API_KEY ? '✅' : '⏭️ '} Cloud Vision API`);
  console.log(`  ⏭️  Cloud Speech-to-Text (upgrade path)`);
  console.log(`  ⏭️  Cloud Storage (upgrade path)\n`);
});
