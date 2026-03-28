# IntentBridge 🌉

**IntentBridge** is a Gemini-powered multimodal intent extraction engine. It takes unstructured, messy, real-world inputs—voice, photos, or text—and instantly converts them into structured, verified, and actionable JSON intelligence. 

Built with a premium dark glassmorphism UI, this application actively orchestrates between Google's **Cloud Vision API** for visual metadata extraction, and **Gemini 2.5 Flash** for deep, multimodal reasoning.

## ✨ Features
- **🎤 True Audio Processing**: Bypasses browser text-to-speech. Records raw WebM audio and streams it directly to Gemini so the AI can perceive tone of voice, urgency, and background sounds.
- **🖼️ Hybrid Visual Pipeline**: Uploaded images are first processed by the GCP Cloud Vision API (OCR, Labels, Object Detection, Face Emotion). This deterministic metadata is appended to the prompt alongside the image and sent to Gemini for highly contextual reasoning.
- **📊 GCP Services Telemetry**: A built-in results panel visualizes exactly which cloud APIs fired, what they found, and their individual latencies in milliseconds.
- **💎 Premium Design**: Fully responsive interface using raw HTML/CSS with custom Micro-animations, urgency color-coding, and dark mode aesthetics.

## 🛠️ Technology Stack
- **Frontend**: Vite 6, Vanilla Javascript, Vanilla CSS
- **Backend/Proxy**: Node.js, Express.js
- **AI / Cloud Services**: 
  - `@google/genai` (Gemini 2.5 Flash)
  - Google Cloud Vision API (`vision.googleapis.com`)

## 🚀 Running Locally

1. **Clone & Install**
   ```bash
   git clone https://github.com/Eatbullets/PromptWars.git
   cd PromptWars
   npm install
   ```

2. **Environment Variables**
   Create a `.env` file in the root directory and add your API keys:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   GCP_API_KEY=your_google_cloud_api_key_here
   ```

3. **Start the Application**
   This will spin up the Express API securely on port `3001` and the Vite hot-reloading frontend on `5173`.
   ```bash
   npm run dev
   ```

## ☁️ Deployment (Google Cloud Run)

The application is containerized and ready for GCP Cloud Run out of the box.

1. **Enable required services on GCP**:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com
   ```

2. **Deploy natively using gcloud**:
   ```bash
   gcloud run deploy intentbridge \
     --source . \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars="GEMINI_API_KEY=your-key,GCP_API_KEY=your-gcp-key"
   ```
   *(Note: For strict production environments, it is recommended to replace `--set-env-vars` with Google Cloud Secret Manager references `--set-secrets`).*
