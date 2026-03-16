"use server";

import { PDFDocument } from "pdf-lib";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

const ZAI_API_KEY = process.env.ZAI_API_KEY || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

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

const initialExtractionPrompt = (startingPage: number) => `
===================================================================================================
ROLE • You are an obsessively precise scientific scribe. Your single mission is to create a
       character-perfect, structure-faithful, machine-readable copy of supplied PDF without
       losing a single glyph.  If PDF ever conflicts with these instructions, PDF wins
       (information-supremacy rule).

PAGE-NUMBERING CONTEXT
• BEGIN TRANSCRIBING IMMEDIATELY from first image you are given.  
• Label that very first image as:
      --- Page ${startingPage} ---
• Continue numbering every subsequent image sequentially:
      --- Page ${startingPage + 1} ---,
      --- Page ${startingPage + 2} ---,
   etc. Never leave gaps or try to "look for" earlier pages that were not supplied.

PRIMARY GOALS
1. 100 % fidelity transcription of every visible glyph (text, maths, code, tables, etc.).
2. RAG-ready hierarchy:
      • H1 = Top-level section.
      • H2, H3, and H4 = Nested subsections inside their nearest ancestor.

DELIVERABLE
• One GitHub-Flavoured Markdown (GFM) file; no extra commentary.  
• Content appears in natural reading order, divided by page markers defined above.

===================================================================================================
GLOBAL RULES (obligatory)
0. PAGE SEQUENCE  
      • Always label pages exactly as described in "PAGE-NUMBERING CONTEXT".
1. VERBATIM TEXT — Reproduce every printed character exactly (capitalisation, diacritics,
   punctuation, bold/italics, line/paragraph breaks). Never paraphrase or reorder.
2. HANDWRITING — If fully legible, transcribe and prefix "[Handwritten: …]".  
   Partially legible → "[…illegible…]".  Completely unreadable → "[ILLEGIBLE]".
3. MATHEMATICS — Zero-tolerance for errors.  
      • Inline → \`$ … $\` Display → \`$$ … $$\`  
      • Preserve original spacing, subscripts, superscripts, Greek, arrows, ∀ ∃ ∈ ≤ ≠ ≈ ⋯  
      • Use Unicode for single-code-point symbols; otherwise LaTeX.  
      • Never simplify or recalculate.
4. CODE / PSEUDOCODE — Fence exactly as printed:  
         \`\`\`<language-if-obvious>
         # original indentation, spaces, blank lines
         \`\`\`
5. TABLES — Prefer Markdown tables. If rowspan/colspan make that impossible, fall back to a
   clearly labelled row-by-row list.
6. FIGURES & DIAGRAMS — Do **not** redraw. Provide one concise description in brackets, then
   caption, e.g.  
         [Figure 3: Scatter plot of error rate vs. epochs.]
7. HEADERS / FOOTERS — If they carry semantic content (chapter title, etc.) include them in
   brackets: "[Footer: Page 12 – Chapter 2]".

===================================================================================================
SECTIONING & HIERARCHY
A. Detect visual hierarchy in source (font size, numbering, bold, indentation).
B. Map detected hierarchy to Markdown headings from H1 down to H4:
      Top-level section → H1 (#)
      Next lower level  → H2 (##)
      Deeper levels     → H3 (###), and H4 (####) as needed.
C. Ensure strict and logical nesting. An H2 must be inside an H1, an H3 inside an H2, and an
   H4 inside an H3. Never skip levels (e.g., do not place an H3 directly after an H1).

===================================================================================================
QUALITY-ASSURANCE PROTOCOL (perform **before** emitting final output)
1. Dual-Pass Entry — Type page once, then re-read image while comparing every character.  
2. Formula Audit — Pointer-check each symbol in every equation.  
3. Structure Audit — Confirm:  
      • Page markers present, correct, and sequential beginning with "--- Page ${startingPage} ---"  
      • Heading hierarchy is logical and strictly follows nesting rules (H2 within H1, H3 within H2, etc., down to H4).
4. Ambiguity Mark-Up — Append "[?]" immediately after any uncertain glyph.  
5. Final Confirmation — Output is valid GFM, free of extra commentary.

===================================================================================================
FAIL-SAFE RULES
• If a rule conflicts with perfect fidelity, fidelity wins; note exception in brackets and
   continue.  
• If a glyph is undecipherable, use "[ILLEGIBLE]" — never invent.

===================================================================================================
BEGIN WORK AS SOON AS THE FIRST PAGE IMAGE IS SUPPLIED. OUTPUT ONLY THE TRANSCRIBED GFM.
===================================================================================================
`;

async function convertLinkToJpeg(url: string): Promise<string> {
  try {
    const axios = (await import("axios")).default;
    const response = await axios({ url, responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data);
    try {
      const sharp = (await import("sharp")).default;
      const jpegBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      return `data:image/jpeg;base64,${jpegBuffer.toString("base64")}`;
    } catch (sharpError) {
      console.warn("Sharp not available, returning original image as base64");
      return `data:${
        response.headers["content-type"] || "image/png"
      };base64,${buffer.toString("base64")}`;
    }
  } catch (error) {
    console.error("Conversion failed", error);
    throw error;
  }
}

async function pdfToTextWithZAI(
  report = false,
  pdfBase64: string,
  startingPage: number,
  endPage?: number
): Promise<string | null> {
  if (!ZAI_API_KEY) {
    console.warn("ZAI_API_KEY is not set, skipping Z.AI Layout Parsing.");
    return null;
  }

  console.log(
    `Attempting Z.AI Layout Parsing API call for pages starting at ${startingPage}`
  );

  try {
    const requestBody: Record<string, unknown> = {
      model: "glm-ocr",
      file: `data:application/pdf;base64,${pdfBase64}`,
    };

    if (startingPage > 1) {
      requestBody.start_page_id = startingPage;
    }
    if (endPage !== undefined) {
      requestBody.end_page_id = endPage;
    }

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
      console.log("Z.AI Report Parsing Response:", data.md_results);
      return data.md_results;
    }
    console.log("Z.AI Layout Parsing Response:", data);

    if (!data.layout_details || data.layout_details.length === 0) {
      console.warn("Z.AI API returned no layout_details.");
      return null;
    }

    const models = [
      "qwen/qwen3-vl-235b-a22b-instruct",
      "qwen/qwen3-vl-30b-a3b-instruct",
      "qwen/qwen3-vl-8b-instruct",
    ];

    const openRouter = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });

    const output = await Promise.all(
      data.layout_details.map(
        async (
          page: Array<{
            native_label?: string;
            label?: string;
            content: string;
          }>,
          pageIndex: number
        ) => {
          page.unshift({
            native_label: "page_break",
            content: `--- Page ${startingPage + pageIndex} ---`,
          });

          const textChunksPromise = page.map(
            async (chunk: {
              native_label?: string;
              label?: string;
              content: string;
            }) => {
              if (chunk.native_label !== "image" && chunk.label !== "image") {
                return `\n${chunk.content}\n`;
              } else {
                console.log("Processing image from ZAI:", chunk.content);
                let result = null;
                let lastError = null;

                for (const model of models) {
                  try {
                    console.log(`Trying model: ${model}`);
                    const ocrPrompt = `> You are an optical character recognition and image analysis engine for a technical Retrieval-Augmented Generation (RAG) system. Your goal is to extract semantic meaning and data for indexing.

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
`;

                    result = await openRouter.chat.completions.create({
                      model: model,
                      temperature: 0,
                      messages: [
                        {
                          role: "user",
                          content: [
                            { type: "text", text: ocrPrompt },
                            {
                              type: "image_url",
                              image_url: {
                                url: await convertLinkToJpeg(chunk.content),
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

                const imageDescription =
                  result.choices[0]?.message?.content || "";
                return `\n\n<Image>\n<ImageDescription>${imageDescription}</ImageDescription>\n</Image>\n\n`;
              }
            }
          );

          const textChunks = await Promise.all(textChunksPromise);
          return textChunks.join("");
        }
      )
    );

    const finalText = output.join("");
    return finalText;
  } catch (error) {
    console.error("FAILURE: Z.AI Layout Parsing API call failed.");
    if (error instanceof Error) {
      console.error("Error Message:", error.message);
    } else {
      console.error("An unknown error occurred:", error);
    }
    return null;
  }
}

export async function pdfToText(
  pdfBase64: string,
  startingPage: number
): Promise<string | null> {
  const prompt = initialExtractionPrompt(startingPage);
  console.log(`Starting PDF extraction from page ${startingPage}.`);

  const zaiResult = await pdfToTextWithZAI(true, pdfBase64, startingPage);
  if (zaiResult) {
    return zaiResult;
  }
  console.log(
    "Z.AI Layout Parsing failed or unavailable, falling back to Gemini..."
  );

  console.log("Trying Gemini fallback with native PDF...");
  const apiKeys = getApiKeys();
  const totalKeys = apiKeys.length;
  const startIndex = Math.floor(Math.random() * totalKeys);

  const fileDataPart = {
    inlineData: {
      mimeType: "application/pdf",
      data: pdfBase64,
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
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent([prompt, fileDataPart]);
      const response = result.response;
      const text = response.text();

      console.log(
        `SUCCESS: Gemini API call succeeded for page ${startingPage}.`
      );
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

  console.error("All API attempts failed. Unable to process PDF.");
  return null;
}

export async function processPdfAndConvertToText(
  pdfBase64Array: string[]
): Promise<string | null> {
  if (!pdfBase64Array.length) {
    console.error("processPdfAndConvertToText received no valid files.");
    return null;
  }

  console.log(`Processing ${pdfBase64Array.length} PDF(s)`);

  try {
    const mergedPdfDoc = await PDFDocument.create();

    for (let idx = 0; idx < pdfBase64Array.length; idx++) {
      const base64 = pdfBase64Array[idx];
      const pdfBytes = Buffer.from(base64, "base64");
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pageIndices = Array.from(
        { length: pdfDoc.getPageCount() },
        (_, i) => i
      );
      const copiedPages = await mergedPdfDoc.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => mergedPdfDoc.addPage(page));
      console.log(`Merged PDF ${idx + 1} (${pdfDoc.getPageCount()} pages)`);
    }

    const mergedPdfBytes = await mergedPdfDoc.save();
    const mergedBase64 = Buffer.from(mergedPdfBytes).toString("base64");
    const pageCount = mergedPdfDoc.getPageCount();

    console.log(`Total merged PDF has ${pageCount} pages`);

    const MAX_PAGES_PER_CHUNK = 99;

    if (pageCount <= MAX_PAGES_PER_CHUNK) {
      console.log("PDF is within 99-page limit, sending directly to glm-ocr.");
      return await pdfToText(mergedBase64, 1);
    }

    console.log(
      `PDF exceeds ${MAX_PAGES_PER_CHUNK} pages, splitting into chunks...`
    );
    const textExtractionPromises: Promise<{
      index: number;
      text: string | null;
    }>[] = [];

    for (let i = 0; i < pageCount; i += MAX_PAGES_PER_CHUNK) {
      const chunkIndex = i / MAX_PAGES_PER_CHUNK;

      const task = (async () => {
        const newPdfDoc = await PDFDocument.create();
        const startPage = i;
        const endPage = Math.min(i + MAX_PAGES_PER_CHUNK, pageCount);
        const pageIndices = Array.from(
          { length: endPage - startPage },
          (_, k) => startPage + k
        );

        const copiedPages = await newPdfDoc.copyPages(
          mergedPdfDoc,
          pageIndices
        );
        copiedPages.forEach((page) => newPdfDoc.addPage(page));

        const chunkPdfBytes = await newPdfDoc.save();
        const chunkBase64 = Buffer.from(chunkPdfBytes).toString("base64");

        const extractedText = await pdfToText(chunkBase64, i + 1);
        return { index: chunkIndex, text: extractedText };
      })();

      textExtractionPromises.push(task);
    }

    console.log(
      `Waiting for ${textExtractionPromises.length} chunks to be processed...`
    );
    const processedChunks = await Promise.all(textExtractionPromises);
    console.log("All chunks have been processed.");

    processedChunks.sort((a, b) => a.index - b.index);

    const fullText = processedChunks
      .filter((chunk) => chunk.text !== null)
      .map((chunk) => chunk.text)
      .join("\n\n");

    console.log("Full text length:", fullText.length);
    return fullText;
  } catch (error) {
    console.error("Failed to process PDF:", error);
    return null;
  }
}
