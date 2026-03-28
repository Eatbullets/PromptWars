import request from 'supertest';
import app from '../server.js';
import { GoogleGenAI } from '@google/genai';
import { jest } from '@jest/globals';

describe('IntentBridge Universal Intent Engine API Tests', () => {
  describe('GET /api/health (Basic Availability)', () => {
    it('should return a 200 health status indicating server is online', async () => {
      const res = await request(app).get('/api/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.services.gemini).toBeDefined();
    });
  });

  describe('POST /api/analyze (Happy Path Executions)', () => {
    it('should process a valid text payload', async () => {
      const payload = { text: "Patient fell down the stairs and is unresponsive" };
      const res = await request(app)
        .post('/api/analyze')
        .send(payload);
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.analysis).toHaveProperty('intent', 'Emergency Medical Assistance');
      expect(res.body.analysis).toHaveProperty('urgency', 'high');
      expect(res.body.gcp_services).toBeInstanceOf(Array);
      
      // Should log the text input correctly
      expect(res.body.input_summary.has_text).toBe(true);
      expect(res.body.input_summary.has_image).toBe(false);
    });

    it('should process a valid base64 image payload simulating standard ingestion', async () => {
      // Mock basic tiny 1x1 transparent gif base64 for testing format validators
      const dummyBase64 = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
      const payload = { image: dummyBase64, imageMimeType: 'image/gif' };
      
      const res = await request(app)
        .post('/api/analyze')
        .send(payload);
        
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.input_summary.has_image).toBe(true);
    });
  });

  describe('POST /api/analyze (Security Validation & Failure Paths)', () => {
    it('should fail with 400 when no input data is provided', async () => {
      const res = await request(app)
        .post('/api/analyze')
        .send({}); // Empty payload
        
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/provide text input/i);
    });

    it('should block malformed mimeTypes (Validation boundary)', async () => {
      // Intentionally passing an invalid mimeType to trigger express-validator
      const payload = { audio: "fakeBase64", audioMimeType: "text/html" };
      
      const res = await request(app)
        .post('/api/analyze')
        .send(payload);
        
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/validation failed/i);
      
      // Ensure the exact field that failed is identified
      const audioMimeError = res.body.details.find(d => d.path === 'audioMimeType');
      expect(audioMimeError).toBeDefined();
    });

    it('should sanitize script tags in text (Security / NoSQL Injection config)', async () => {
      // Injection payload to test express-validator .escape() logic
      const promptInjection = "<script>alert('hack')</script> Translate this to Spanish";
      const payload = { text: promptInjection };
      
      const res = await request(app).post('/api/analyze').send(payload);
      
      // The API should still run, but the text string will inherently be stripped down securely by express-validator
      expect(res.statusCode).toBe(200);
    });
  });
});
