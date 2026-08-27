// server.js
// Backend proxy untuk WhatsApp QR Code & AI Business Suite.
// Tugasnya: menyimpan GEMINI_API_KEY di server (tidak pernah dikirim ke browser)
// dan meneruskan permintaan AI dari frontend ke Gemini API.

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.warn('⚠️  PERINGATAN: GEMINI_API_KEY belum diset. Buat file .env (lihat .env.example) sebelum deploy.');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Batasi jumlah request per IP supaya API key server tidak jebol dipakai orang lain
// lewat website kamu (mis. dibuka script berulang-ulang).
const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 menit
    max: 20,             // maksimal 20 request AI per menit per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' }
});
app.use('/api/', aiLimiter);

// Daftar model yang boleh dipakai — mencegah frontend memaksa server memanggil
// model sembarangan kalau suatu saat endpoint ini diperluas.
const MODELS = {
    text: 'gemini-3-flash-preview',
    tts: 'gemini-2.5-flash-preview-tts',
    image: 'gemini-3.1-flash-image'
};

async function callGemini(model, payload) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY belum diatur di server');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
        const msg = data?.error?.message || `Gemini API error (${response.status})`;
        throw new Error(msg);
    }
    return data;
}

// --- Teks umum: pre-filled message, greeting/FAQ suite, broadcast, chatbot reply ---
app.post('/api/text', async (req, res) => {
    try {
        const { prompt, systemInstruction } = req.body || {};
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ error: 'Field "prompt" wajib diisi.' });
        }
        const payload = { contents: [{ parts: [{ text: prompt }] }] };
        if (systemInstruction && typeof systemInstruction === 'string') {
            payload.systemInstruction = { parts: [{ text: systemInstruction }] };
        }
        const data = await callGemini(MODELS.text, payload);
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Gagal mengambil respons AI');
        res.json({ text: text.trim() });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// --- CRM Chat Analyzer: respons terstruktur JSON ---
app.post('/api/analyze', async (req, res) => {
    try {
        const { message } = req.body || {};
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ error: 'Field "message" wajib diisi.' });
        }
        const payload = {
            contents: [{ parts: [{ text: 'Analisis pesan pelanggan berikut dan berikan respons terstruktur: ' + message }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: {
                        intent: { type: 'STRING', description: 'Tujuan utama pelanggan (misal: Beli, Komplain, Tanya Harga)' },
                        urgency: { type: 'STRING', description: 'Tingkat urgensi: Rendah, Sedang, atau Tinggi' },
                        sentiment: { type: 'STRING', description: 'Sentimen: Positif, Netral, atau Negatif' },
                        recommendedReply: { type: 'STRING', description: 'Rekomendasi draf balasan chat WhatsApp yang ramah' }
                    },
                    propertyOrdering: ['intent', 'urgency', 'sentiment', 'recommendedReply']
                }
            }
        };
        const data = await callGemini(MODELS.text, payload);
        const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) throw new Error('Gagal mengambil respons AI');
        const parsed = JSON.parse(jsonText);
        res.json(parsed);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// --- AI Voice Note (TTS) ---
const ALLOWED_VOICES = ['Kore', 'Puck', 'Zephyr', 'Fenrir'];
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice } = req.body || {};
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Field "text" wajib diisi.' });
        }
        const chosenVoice = ALLOWED_VOICES.includes(voice) ? voice : 'Kore';
        const payload = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: chosenVoice } } }
            }
        };
        const data = await callGemini(MODELS.tts, payload);
        const part = data?.candidates?.[0]?.content?.parts?.[0];
        const audioData = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;
        if (!audioData || !mimeType || !mimeType.startsWith('audio/')) {
            throw new Error('Gagal membuat audio');
        }
        res.json({ audioData, mimeType });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// --- AI Promo Poster (Gemini Image / "Nano Banana") ---
app.post('/api/image', async (req, res) => {
    try {
        const { prompt } = req.body || {};
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ error: 'Field "prompt" wajib diisi.' });
        }
        const payload = {
            contents: [{ parts: [{ text: 'Professional WhatsApp business marketing poster, vibrant colors, clean layout for: ' + prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] }
        };
        const data = await callGemini(MODELS.image, payload);
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
        if (!imagePart) throw new Error('Gagal membuat gambar');
        res.json({
            imageData: imagePart.inlineData.data,
            mimeType: imagePart.inlineData.mimeType || 'image/png'
        });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
});
