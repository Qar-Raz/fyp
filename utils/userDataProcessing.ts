"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { processPdfAndConvertToText } from "./pdfProcessing";

const ZAI_API_KEY = process.env.ZAI_API_KEY || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

const imageExtractionPrompt = `
===================================================================================================
ROLE • You are a medical document scribe. Your mission is to extract all text and medical
        information from provided image with high accuracy.

PRIMARY GOALS
1. Extract all visible text from image.
2. Preserve structure and hierarchy of information.
3. Identify and categorize medical information (patient details, diagnoses, medications, etc.).

DELIVERABLE
• One GitHub-Flavoured Markdown (GFM) file with extracted text.
• Use appropriate Markdown formatting (headings, lists, tables) to preserve structure.
• No extra commentary, only extracted content.

===================================================================================================
GLOBAL RULES (obligatory)
1. VERBATIM TEXT — Reproduce every printed character exactly (capitalisation, diacritics,
   punctuation, line/paragraph breaks). Never paraphrase or reorder.
2. HANDWRITING — If fully legible, transcribe and prefix "[Handwritten: …]".
   Partially legible → "[…illegible…]". Completely unreadable → "[ILLEGIBLE]".
3. TABLES — Use Markdown tables to preserve tabular data.
4. HEADINGS — Detect visual hierarchy and use Markdown headings (#, ##, ###) appropriately.
5. MEDICAL TERMS — Preserve all medical terminology exactly as written.

===================================================================================================
QUALITY-ASSURANCE PROTOCOL (perform **before** emitting final output)
1. Verify all text has been extracted.
2. Check that medical information is preserved accurately.
3. Ensure proper Markdown formatting.

===================================================================================================
FAIL-SAFE RULES
• If text is undecipherable, use "[ILLEGIBLE]" — never invent.
• Preserve original structure as much as possible.

===================================================================================================
BEGIN WORK AS SOON AS THE IMAGE IS SUPPLIED. OUTPUT ONLY THE EXTRACTED GFM.
===================================================================================================
`;

/**
 * Calls Z.AI Layout Parsing API (glm-ocr) to extract text from an image.
 * Accepts a base64-encoded image directly.
 * Processes images within PDF using qwen model for OCR.
 * Returns markdown-formatted text or null on failure.
 */
async function imageToTextWithZAI(
  report = false,
  imageBase64: string,
  mimeType: string
): Promise<string | null> {
  if (!ZAI_API_KEY) {
    console.warn("ZAI_API_KEY is not set, skipping Z.AI Layout Parsing.");
    return null;
  }

  console.log("Attempting Z.AI Layout Parsing API call for image...");

  try {
    const requestBody = {
      model: "glm-ocr",
      file: `data:${mimeType};base64,${imageBase64}`,
    };

    const response = await fetch(
      "https://api.z.ai/api/paas/v4/layout_parsing",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ZAI_API_KEY,
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Z.AI API returned status ${response.status}: ${errorText}`
      );
      return null;
    }

    const data = await response.json();
    if (report) {
      return data.md_results;
    }
    console.log("Z.AI Layout Parsing Response:", data);

    if (!data.layout_details || data.layout_details.length === 0) {
      console.warn("Z.AI API returned no layout_details.");
      return null;
    }

    // Get the first page's layout details
    const page = data.layout_details[0];

    if (!page) {
      console.warn("Z.AI API returned no layout_details.");
      return null;
    }

    // Models to try for image processing
    const models = [
      "qwen/qwen3-vl-235b-a22b-instruct",
      "qwen/qwen3-vl-30b-a3b-instruct",
      "qwen/qwen3-vl-8b-instruct",
    ];

    // Initialize OpenRouter client
    const openRouter = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });

    // Process the page's layout details
    const output = await Promise.all(
      page.map(
        async (chunk: {
          native_label?: string;
          label?: string;
          content: string;
        }) => {
          // Process non-image chunks
          if (chunk.native_label !== "image" && chunk.label !== "image") {
            return `\n${chunk.content}\n`;
          } else {
            // Process image chunk using qwen model
            console.log("Processing image from ZAI:", chunk.content);
            let result = null;
            let lastError = null;

            for (const model of models) {
              try {
                console.log(`Trying model: ${model}`);
                result = await openRouter.chat.completions.create({
                  model: model,
                  temperature: 0,
                  messages: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "text",
                          text: `> You are an optical character recognition and image analysis engine for a technical Retrieval-Augmented Generation (RAG) system. Your goal is to extract semantic meaning and data for indexing.

> **CORE INSTRUCTIONS:**
1. **Start Phrase:** Begin immediately with "This is a [image type]..." (e.g., chart, graph, diagram, text block).
2. **Grounding:** Describe ONLY what is strictly visible. Do not infer, guess, or hallucinate objects that are not clearly defined. If a shape is ambiguous, ignore it or call it "indistinct shape." Do not use external knowledge to fill in gaps.
3. **Format:** Output a single, dense paragraph.

> **CONTENT-SPECIFIC RULES:**
- **Charts/Graphs:** Explicitly transcribe axis titles, **units and symbols** (e.g., $, £, %, kg), and range of tick marks. Describe shape/direction of lines (e.g., "upward sloping," "convex"). Crucially, identify and transcribe **key data points** (intersections, maxima, minima) and their labels exactly.
- **Text:** Transcribe all visible text exactly, preserving case and punctuation.
- **Logos/Icons:** If a university or corporate logo is present, name entity if legible (e.g., "University of Calgary logo"), but **DO NOT** describe visual design elements (animals, colors, shapes) of logo.
- **Diagrams:** Explain flow or relationship between components.

> **FINAL CHECK:** Ensure no visual artifacts (scrollbars, cursors) are described. Verify that specific symbols (like currency signs on axes) are included if present.
`,
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: chunk.content,
                          },
                        },
                      ],
                    },
                  ],
                });

                console.log(
                  `Successfully processed image with model: ${model}`
                );
                break;
              } catch (error) {
                lastError = error;
                console.error(`Failed with model ${model}:`, error);
              }
            }

            if (!result) {
              throw new Error(
                `All models failed to process image. Last error: ${lastError}`
              );
            }

            const imageDescription = result.choices[0]?.message?.content || "";

            return `\n\n<Image>\n<ImageDescription>${imageDescription}</ImageDescription>\n</Image>\n\n`;
          }
        }
      )
    );

    const finalText = output.join("");
    return finalText;
  } catch (error) {
    console.error("FAILURE: Z.AI Layout Parsing API call failed.");
    if (error instanceof Error) {
      console.error("Error Message:", error.message);
    }
    return null;
  }
}

/**
 * Extract text from an image.
 * Primary: Z.AI Layout Parsing (glm-ocr) with base64 image input.
 * Fallback: Gemini Vision, then OpenRouter.
 */
async function imageToText(
  imageBase64: string,
  mimeType: string
): Promise<string | null> {
  // ── Primary: Z.AI Layout Parsing (glm-ocr) ──
  const zaiResult = await imageToTextWithZAI(true, imageBase64, mimeType);
  if (zaiResult) {
    return zaiResult;
  }
  console.log(
    "Z.AI Layout Parsing failed or unavailable, falling back to Gemini..."
  );

  // ── Fallback: Gemini Vision ──
  const prompt = imageExtractionPrompt;
  const apiKeys = getApiKeys();
  const totalKeys = apiKeys.length;
  const startIndex = Math.floor(Math.random() * totalKeys);

  console.log(`Starting Gemini image extraction. Total keys: ${totalKeys}.`);

  const fileDataPart = {
    inlineData: {
      mimeType,
      data: imageBase64,
    },
  };

  for (let i = 0; i < totalKeys; i++) {
    const currentIndex = (startIndex + i) % totalKeys;
    const apiKey = apiKeys[currentIndex];

    console.log(
      `Attempting Gemini API call with key at index: ${currentIndex}`
    );

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-3-flash-preview",
      });

      const result = await model.generateContent([prompt, fileDataPart]);
      const response = result.response;
      const text = response.text();

      console.log("SUCCESS: Gemini API call succeeded for image.");
      console.log("Response Text Length:", text?.length ?? 0);

      if (text === undefined || text === null) {
        console.warn(
          "Response text was undefined or null, returning empty content."
        );
        return "";
      }

      return text;
    } catch (error) {
      console.error(
        `FAILURE: Gemini API call with key at index ${currentIndex} failed.`
      );
      if (error instanceof Error) {
        console.error("Error Message:", error.message);
      }
    }
  }

  console.error("All API attempts failed. Unable to process image.");
  return null;
}

/**
 * Process user data files (PDFs and images) and extract text.
 */
export async function processUserDataFiles(
  files: Array<{ base64: string; type: "pdf" | "image"; name: string }>
): Promise<string | null> {
  if (!files.length) {
    console.error("processUserDataFiles received no valid files.");
    return null;
  }

  console.log(`Processing ${files.length} user data file(s)`);

  try {
    const textParts: string[] = [];

    for (const file of files) {
      console.log(`Processing file: ${file.name} (${file.type})`);

      if (file.type === "pdf") {
        // Use PDF processing
        const pdfText = await processPdfAndConvertToText([file.base64]);
        if (pdfText) {
          textParts.push(`## File: ${file.name}\n\n${pdfText}`);
        }
      } else if (file.type === "image") {
        // Extract text from image
        const imageText = await imageToText(
          file.base64,
          getMimeType(file.name)
        );
        if (imageText) {
          textParts.push(`## File: ${file.name}\n\n${imageText}`);
        }
      }
    }

    const fullText = textParts.join("\n---\n\n");
    console.log("Full text length:", fullText.length);
    return fullText;
  } catch (error) {
    console.error("Failed to process user data files:", error);
    return null;
  }
}

/**
 * Get MIME type based on file extension.
 */
function getMimeType(filename: string): string {
  const ext = filename.split(".").pop();
  if (!ext) return "image/jpeg";

  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return mimeTypes[ext] || "image/jpeg";
}

/**
 * Retrieves and validates Gemini API keys from environment variables.
 */
function getApiKeys(): string[] {
  const apiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY2,
    process.env.KeyForRoadmap_API_KEY,
    process.env.GEMINI_API_KEY3,
  ].filter((key): key is string => !!key);

  if (apiKeys.length === 0) {
    console.error("No GEMINI_API_KEY environment variables are set.");
    throw new Error("Server configuration error: Missing Gemini API Keys.");
  }

  return apiKeys;
}
