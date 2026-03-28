import { GoogleGenAI } from '@google/genai';
import { BigQuery } from '@google-cloud/bigquery';
import dotenv from 'dotenv';
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GCP_API_KEY = process.env.GCP_API_KEY;

export const bigquery = new BigQuery(); // Native BQ Data Pipeline Init

// ── Google Cloud Vision API ──
export async function analyzeWithVision(base64Image, mimeType) {
  if (process.env.NODE_ENV === 'test') {
    return {
      success: true,
      skipped: false,
      labels: [{ description: 'Test Label', score: 0.9 }],
      ocrText: '',
      objects: [],
      faces: [],
      safeSearch: { adult: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY' },
      labelCount: 1,
      objectCount: 0,
      faceCount: 0,
      hasText: false,
      latency: 12
    };
  }

  if (!GCP_API_KEY) {
    return { skipped: true, reason: 'GCP_API_KEY not configured' };
  }

  const startTime = Date.now();
  const requestPayload = {
    requests: [
      {
        image: { content: base64Image },
        features: [
          { type: 'LABEL_DETECTION', maxResults: 10 },
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'OBJECT_LOCALIZATION', maxResults: 10 },
          { type: 'FACE_DETECTION' },
          { type: 'SAFE_SEARCH_DETECTION' }
        ]
      }
    ]
  };

  try {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GCP_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Vision API Error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const result = data.responses[0];

    const labels = (result.labelAnnotations || []).map(l => ({ description: l.description, score: l.score }));
    const ocrText = result.fullTextAnnotation ? result.fullTextAnnotation.text.trim() : null;
    const objects = (result.localizedObjectAnnotations || []).map(o => ({ name: o.name, score: o.score }));
    const faces = (result.faceAnnotations || []).map(f => ({
      joy: f.joyLikelihood, sorrow: f.sorrowLikelihood, anger: f.angerLikelihood, surprise: f.surpriseLikelihood
    }));
    const safeSearch = result.safeSearchAnnotation || null;

    return {
      success: true,
      skipped: false,
      labels,
      ocrText,
      objects,
      faces,
      safeSearch,
      labelCount: labels.length,
      objectCount: objects.length,
      faceCount: faces.length,
      hasText: !!ocrText,
      latency: Date.now() - startTime
    };
  } catch (error) {
    return { success: false, skipped: false, error: error.message };
  }
}

export function formatVisionContext(visionResult) {
  if (!visionResult || !visionResult.success || visionResult.skipped) return '';
  const parts = [];
  
  parts.push("=== CLOUD VISION API METADATA ===");
  if (visionResult.labels.length > 0) {
    parts.push(`Image Labels: ${visionResult.labels.map(l => `${l.description} (${(l.score * 100).toFixed(0)}%)`).join(', ')}`);
  }
  
  if (visionResult.hasText) {
    parts.push(`Extracted Text (OCR):\n"${visionResult.ocrText}"`);
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

// ── Gemini Multimodal Analysis ──
export async function analyzeWithGemini(textInput, imageData, imageMimeType, audioData, audioMimeType, visionContext, systemPrompt) {
  if (process.env.NODE_ENV === 'test') {
    return {
      result: {
        intent: "Emergency Medical Assistance",
        category: "medical",
        urgency: "high",
        confidence: 0.95,
        entities: [{ type: "condition", value: "fall", context: "stairs" }],
        recommended_actions: [
          { priority: 1, action: "Dispatch ambulance", responsible_party: "EMS", timeframe: "Immediate" }
        ],
        context_flags: ["Patient unconscious"]
      },
      latency: 42
    };
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const startTime = Date.now();

  const contents = [];

  const textParts = [];
  if (textInput) textParts.push(textInput);
  if (visionContext) textParts.push(visionContext);
  if (textParts.length > 0) {
    contents.push({ text: `Analyze the following input and extract structured intent:\n\n${textParts.join('\n\n')}` });
  }

  if (imageData) {
    contents.push({
      inlineData: { mimeType: imageMimeType || 'image/jpeg', data: imageData },
    });
    if (!textInput && !visionContext) {
      contents.push({ text: 'Analyze this image and extract structured intent. What situation does it depict? What actions should be taken?' });
    }
  }

  if (audioData) {
    contents.push({
      inlineData: { mimeType: audioMimeType || 'audio/webm', data: audioData },
    });
    if (!textInput && !imageData) {
      contents.push({ text: 'Listen to this audio recording and extract structured intent. Pay attention to tone of voice, urgency, emotion, and background sounds.' });
    }
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: contents,
    config: { systemInstruction: systemPrompt, temperature: 0.2 },
  });

  const latency = Date.now() - startTime;
  const rawText = response.text.trim();

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
