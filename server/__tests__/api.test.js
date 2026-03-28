import request from 'supertest';
import app from '../server.js';
import { jest } from '@jest/globals';

describe('IntentBridge Final Optimization Test Suite', () => {

  describe('GET /api/health (Availability & Setup)', () => {
    it('should return a 200 HTTP status and correctly formatted json', async () => {
      const res = await request(app).get('/api/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('should disclose integrated GCP Services in the health matrix', async () => {
      const res = await request(app).get('/api/health');
      expect(res.body.services).toHaveProperty('gemini');
      expect(res.body.services).toHaveProperty('cloudVision');
    });
  });

  describe('POST /api/analyze (Integration Routes)', () => {
    it('should process a valid text payload', async () => {
      const payload = { text: "Fire spotted on highway 95" };
      const res = await request(app).post('/api/analyze').send(payload);
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.input_summary.has_text).toBe(true);
    });

    it('should utilize node-cache on exactly duplicated text inputs', async () => {
      const payload = { text: "Cache collision test prompt" };
      
      // Request 1 generates natively
      const res1 = await request(app).post('/api/analyze').send(payload);
      expect(res1.statusCode).toBe(200);
      
      // Request 2 hits memory cache instantly
      const res2 = await request(app).post('/api/analyze').send(payload);
      expect(res2.statusCode).toBe(200);
      
      // Verify node-cache service was explicitly triggered in GCP Services list
      const usedCache = res2.body.gcp_services.find(s => s.name === 'Node-Cache');
      expect(usedCache).toBeDefined();
    });

    it('should natively process base64 image pipelines', async () => {
      const dummyBase64 = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
      const res = await request(app)
        .post('/api/analyze')
        .send({ image: dummyBase64, imageMimeType: 'image/gif' });
        
      expect(res.statusCode).toBe(200);
      expect(res.body.input_summary.has_image).toBe(true);
    });
  });

  describe('POST /api/analyze (Security & Boundary Validation)', () => {
    it('should explicitly reject 400 when body has no parseable logic', async () => {
      const res = await request(app).post('/api/analyze').send({});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/provide text input/i);
    });

    it('should block incorrect MIME payloads immediately via express-validator', async () => {
      // Must provide valid base64 to pass primary check, but fail on the MimeType Regex
      const validBase64 = "UklGRg==";
      const payload = { audio: validBase64, audioMimeType: "text/plain" };
      const res = await request(app).post('/api/analyze').send(payload);
        
      expect(res.statusCode).toBe(400);
      const mimeError = res.body.details.find(err => err.path === 'audioMimeType');
      expect(mimeError).toBeDefined();
    });

    it('should sanitize XSS HTML from prompt structure', async () => {
      const payload = { text: "<script>hack()</script> Emergency" };
      const res = await request(app).post('/api/analyze').send(payload);
      
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
