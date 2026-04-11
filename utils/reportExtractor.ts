"use server";

import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";

const openRouter = new OpenAI({
  baseURL:
    "https://muddasirjaved9--example-qwen3-5-4b-awq-inference-vllmser-8bd3d3.modal.run/v1",
  apiKey: process.env.OPENROUTER_API_KEY || "",
});

function getGeminiApiKeys(): string[] {
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

// ============================================================================
// INTERFACES
// ============================================================================

export interface ExtractedReportValue {
  key: string;
  value: string;
  unit: string | null;
}

export interface ExtractedReportData {
  hospitalName: string | null;
  reportDate: string | null;
  testValues: ExtractedReportValue[];
  passed: boolean | null;
  fidelityScore: number | null;
  conclusion: string | null;
}

//// interface ReportMetadata {
//  hospitalName: string | null;
//  reportDate: string | null;
////  passed: boolean;
//}

interface FidelityScoreResult {
  fidelityScore: number;
  explanation: string;
  passed: boolean;
}

// ============================================================================
// PDF TO IMAGE CONVERSION
// ============================================================================

/**
 * Convert PDF base64 to images using mutool
 */
async function convertPdfToImages(pdfBase64: string): Promise<string[]> {
  console.log("Starting PDF to image conversion");

  // Create a unique temporary directory for this run
  const runId = uuidv4();
  const tmpDir = path.join("/tmp", runId);
  fs.mkdirSync(tmpDir, { recursive: true });

  const inputPdfPath = path.join(tmpDir, "input.pdf");
  const outputPattern = path.join(tmpDir, "page-%d.png");

  try {
    // 1. Write the base64 PDF to a file
    const buffer = Buffer.from(pdfBase64, "base64");
    fs.writeFileSync(inputPdfPath, buffer);

    // 2. Use mutool to convert PDF to PNGs
    execSync(`mutool draw -o "${outputPattern}" -r 216 "${inputPdfPath}"`);

    // 3. Read the generated images back into base64
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".png"));
    // Sort files numerically to ensure page order (page-1, page-2, etc.)
    files.sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || "0");
      const numB = parseInt(b.match(/\d+/)?.[0] || "0");
      return numA - numB;
    });

    const images: string[] = [];
    for (const file of files) {
      const imageBuffer = fs.readFileSync(path.join(tmpDir, file));
      images.push(`data:image/png;base64,${imageBuffer.toString("base64")}`);
    }

    console.log(`Converted PDF to ${images.length} images`);
    return images;
  } finally {
    // Cleanup: remove temporary directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Prepare image input for vision model
 * Returns base64 image data with proper data URI prefix
 */
async function prepareImageInput(
  fileBase64: string,
  fileType: "pdf" | "image"
): Promise<string> {
  if (fileType === "image") {
    // If it's already an image, ensure it has the proper data URI prefix
    if (fileBase64.startsWith("data:image/")) {
      return fileBase64;
    }
    // Detect image type from magic bytes or default to jpeg
    const buffer = Buffer.from(fileBase64, "base64");
    const firstBytes = buffer.slice(0, 4).toString("hex");

    let mimeType = "image/jpeg"; // Default to JPEG

    // Check for PNG signature (89 50 4E 47)
    if (firstBytes.startsWith("89504e47")) {
      mimeType = "image/png";
    }
    // Check for JPEG signature (FF D8 FF)
    else if (firstBytes.startsWith("ffd8ff")) {
      mimeType = "image/jpeg";
    }
    // Check for GIF signature (47 49 46 38)
    else if (firstBytes.startsWith("47494638")) {
      mimeType = "image/gif";
    }
    // Check for WebP signature (52 49 46 46 ... 57 45 42 50)
    else if (firstBytes.startsWith("52494646")) {
      mimeType = "image/webp";
    }

    return `data:${mimeType};base64,${fileBase64}`;
  } else {
    // If it's a PDF, convert to images and return the first page
    const images = await convertPdfToImages(fileBase64);
    return images[0] || ""; // Return first page for analysis
  }
}

// ============================================================================
// EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Calculate fidelity score using Gemini 3
 */
async function calculateFidelityScore(
  imageBase64: string,
  ocrText: string,
  testValues: ExtractedReportValue[],
  hospitalName: string | null,
  reportDate: string | null
): Promise<FidelityScoreResult> {
  console.log("=== STARTING FIDELITY SCORE CALCULATION ===");

  // Prepare the data summary for the prompt
  const testValuesSummary = testValues
    .map((tv) => `- ${tv.key}: ${tv.value} ${tv.unit || ""}`)
    .join("\n");

  const userContent = `
OCR TEXT:
${ocrText.substring(0, 5000)}${ocrText.length > 5000 ? "..." : ""}

EXTRACTED KEY-VALUE PAIRS:
${testValuesSummary || "No values extracted"}

EXTRACTED METADATA:
- Hospital Name: ${hospitalName || "Not extracted"}
- Report Date: ${reportDate || "Not extracted"}

Please analyze the image and extracted data to calculate a fidelity score. Do not deduct points for formatting issues or things being in lower case or upper case. Focus on the accuracy of the extracted values and metadata compared to the image.- Set 'passed' to true if you are confident you extracted the data accurately
`;

  // Get API keys
  const apiKeys = getGeminiApiKeys();
  const totalKeys = apiKeys.length;

  // Start with a random key to distribute the initial load, then cycle sequentially on failure
  const startIndex = Math.floor(Math.random() * totalKeys);

  console.log(`Starting Fidelity Score Calculation. Total keys: ${totalKeys}.`);

  // Extract MIME type from data URI (prepare once before the loop)
  let mimeType = "image/png"; // Default fallback
  const match = imageBase64.match(/^data:([^;]+);base64,/);
  if (match && match[1]) {
    mimeType = match[1];
  }

  const imagePart = {
    inlineData: {
      data: imageBase64.split(",")[1],
      mimeType: mimeType,
    },
  };

  // Add JSON output instruction to the prompt
  const jsonPrompt = `${userContent}

IMPORTANT: You must respond with a valid JSON object in the following format:
{
  "fidelityScore": <number between 0.0 and 1.0>,
  "explanation": "<brief explanation of the score>",
  "passed": { type: "boolean" },
}

Do not include any other text or formatting. Just the JSON object.`;

  // Loop through all keys, ensuring each one is tried at most once
  for (let i = 0; i < totalKeys; i++) {
    const currentIndex = (startIndex + i) % totalKeys;
    const apiKey = apiKeys[currentIndex];

    console.log(`Attempting API call with key at index: ${currentIndex}`);

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-3-flash-preview",
      });

      const result = await model.generateContent([jsonPrompt, imagePart]);

      const responseText = result.response.text();
      console.log("=== FIDELITY SCORE RAW RESPONSE ===");
      console.log(responseText);
      console.log("=== END FIDELITY SCORE RAW RESPONSE ===");

      // Try to extract JSON from the response (in case there's extra text)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      const jsonText = jsonMatch ? jsonMatch[0] : responseText;

      const fidelityResult: FidelityScoreResult = JSON.parse(jsonText);

      // Validate the result
      if (typeof fidelityResult.fidelityScore !== "number") {
        throw new Error(
          `Invalid fidelityScore type: ${typeof fidelityResult.fidelityScore}`
        );
      }

      console.log("=== PARSED FIDELITY SCORE RESULT ===");
      console.log(`Score: ${fidelityResult.fidelityScore}`);
      console.log(`Explanation: ${fidelityResult.explanation}`);
      console.log("=== END PARSED FIDELITY SCORE RESULT ===");
      console.log(
        `SUCCESS: API call with key at index ${currentIndex} succeeded.`
      );

      return fidelityResult; // Success! Exit the loop and the function.
    } catch (error) {
      console.error(
        `FAILURE: API call with key at index ${currentIndex} failed.`
      );
      if (error instanceof Error) {
        console.error("Error Message:", error.message);
        // Check for common, identifiable errors
        if (
          error.message.includes("429") ||
          error.message.includes("RESOURCE_EXHAUSTED")
        ) {
          console.error(
            `Reason: Rate limit likely exceeded for key index ${currentIndex}.`
          );
        } else if (
          error.message.includes("400") &&
          error.message.includes("API_KEY_INVALID")
        ) {
          console.error(`Reason: API key at index ${currentIndex} is invalid.`);
        }
      } else {
        console.error("An unknown error occurred:", error);
      }

      // If this was the last key to try, the loop will end and we will fall through to the final error message.
    }
  }

  // All keys failed
  console.error("All Gemini API keys failed for fidelity score calculation.");
  return {
    fidelityScore: 0.0,
    explanation:
      "Failed to calculate fidelity score: All API keys were exhausted.",
    passed: false,
  };
}

// ============================================================================
// MAIN EXPORT FUNCTION
// ============================================================================

/**
 * Execute a promise-returning function with retries
 */
async function fetchWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 5
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        throw error;
      }
      const timeoutSec = Math.floor(Math.random() * 3) + 1; // 1 to 3 seconds
      console.log(
        `API call failed. Retrying in ${timeoutSec}s... (Attempt ${
          attempt + 1
        }/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, timeoutSec * 1000));
    }
  }
  throw new Error("Maximum retries reached");
}

/**
 * Extract all structured data from medical report using Qwen Vision
 *
 * @param ocrText - OCR text extracted from the document
 * @param fileBase64 - Base64 encoded file (PDF or image)
 * @param fileType - Type of file ('pdf' or 'image')
 * @returns Extracted report data with fidelity score
 */
export async function extractReportDataWithAI(
  ocrText: string,
  fileBase64: string,
  fileType: "pdf" | "image"
): Promise<ExtractedReportData> {
  console.log("=== STARTING MULTI-STAGE AI REPORT EXTRACTION ===");

  try {
    console.log("\n--- STEP 1: Processing file to image ---");
    const imageBase64 = await prepareImageInput(fileBase64, fileType);

    console.log("\n--- STEP 2: Extracting all data directly from image ---");
    const TEST_VALUES_EXTRACTION_PROMPT = `You are an elite medical data extraction AI. You are provided with an image of a medical laboratory report. 
Your primary directive is EXHAUSTIVE EXTRACTION. You must accurately extract every single test result into the required JSON format. Missing even one test result is a critical failure.

### EXTRACTION INSTRUCTIONS:

Process the document systematically, line-by-line, top-to-bottom, left-to-right. For every diagnostic test found, extract the following into the "testValues" array:

1. "key": The specific name of the test (e.g., "HEMOGLOBIN", "CHOLESTEROL", "TSH", "Neutrophils"). 
   - Capture the exact name.
   - Do NOT include overarching category headers (like "Biochemistry" or "Complete Blood Count").

2. "value": The patient's exact recorded result as a string.
   - Capture the exact characters (e.g., "5.4", "10.6 L", "<0.01", "Positive", "Negative", "Trace").
   - Include any decimal points, mathematical operators (<, >), and attached flags (like 'H', 'L', '*', or 'High').

3. "unit": The unit of measurement (e.g., "mg/dL", "mmol/L", "%", "10^9/L"). 
   - If no unit is visually present next to the result, return null.

### STRICT RULES & COMMON MISTAKES TO AVOID:
- RULE 1: ZERO OMISSIONS / NO LAZINESS. You must extract EVERY test on the page. Do not summarize, do not truncate, and NEVER use ellipses ("...") to skip data. If there are 50 tests, you must output 50 JSON objects.
- RULE 2: AVOID REFERENCE RANGES. Never extract the "Reference Range", "Normal Range", or "Biological Interval" as the test value. Visually distinguish the "Result" column from the "Reference" column.
- RULE 3: ZERO HALLUCINATION. Do not guess, infer, calculate, or make up data. Extract only what is visibly printed. If a value is unreadable, skip it.
- RULE 4: IGNORE NON-TEST DATA. Ignore patient names, doctor names, demographics, clinic addresses, barcodes, and page numbers. Focus strictly on the diagnostic test line items.

### REQUIRED JSON OUTPUT FORMAT:
You must return ONLY valid, well-formed JSON matching the following structure. Do not wrap the JSON in markdown code blocks or add any conversational text.

{
  "testValues": [
    {
      "key": "string",
      "value": "string",
      "unit": "string | null"
    }
  ]
}`;

    const METADATA_EXTRACTION_PROMPT = `You are an elite medical data extraction AI. You are provided with an image of a medical laboratory report.
Your task is to accurately extract the hospital name and report date into the required JSON format.

### EXTRACTION INSTRUCTIONS:

1. hospitalName:
- Look at the top header or logo area for the laboratory, clinic, or hospital name.
- Extract exactly as written. If completely missing, return null.

2. reportDate:
- Look for "Report Date", "Collected Date", "Result Date", or "Date".
- CAUTION: DO NOT confuse this with the patient's Date of Birth (DOB).
- You MUST normalize and convert the extracted date to strictly "YYYY-MM-DD" format (e.g., "12/31/2023" -> "2023-12-31", "05-Aug-2024" -> "2024-08-05").
- If missing or unreadable, return null.`;

    const testValuesResponse = await fetchWithRetry(() =>
      openRouter.chat.completions.create({
        model: "cyankiwi/Qwen3.5-4B-AWQ-4bit",
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageBase64 } },
              { type: "text", text: TEST_VALUES_EXTRACTION_PROMPT },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "medical_test_values",
            strict: true,
            schema: {
              type: "object",
              properties: {
                testValues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      value: { type: "string" },
                      unit: { type: ["string", "null"] },
                    },
                    required: ["key", "value", "unit"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["testValues"],
              additionalProperties: false,
            },
          },
        },
      })
    );

    const testValuesContent = testValuesResponse.choices[0]?.message?.content;
    if (!testValuesContent)
      throw new Error("No content in test values extraction fallback");
    const extractedTestValuesData = JSON.parse(testValuesContent);

    const metadataResponse = await fetchWithRetry(() =>
      openRouter.chat.completions.create({
        model: "cyankiwi/Qwen3.5-4B-AWQ-4bit",
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageBase64 } },
              { type: "text", text: METADATA_EXTRACTION_PROMPT },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "medical_report_metadata",
            strict: true,
            schema: {
              type: "object",
              properties: {
                hospitalName: { type: ["string", "null"] },
                reportDate: { type: ["string", "null"] },
              },
              required: ["hospitalName", "reportDate"],
              additionalProperties: false,
            },
          },
        },
      })
    );

    const metadataContent = metadataResponse.choices[0]?.message?.content;
    if (!metadataContent)
      throw new Error("No content in metadata extraction AI response");
    const extractedMetadata = JSON.parse(metadataContent);

    let finalHospitalName = extractedMetadata.hospitalName;
    if (finalHospitalName) {
      finalHospitalName = finalHospitalName.toUpperCase();
    }
    const testValues = (extractedTestValuesData.testValues || []).map(
      (tv: ExtractedReportValue) => ({
        key: tv.key.toUpperCase(),
        value: tv.value,
        unit: tv.unit ? tv.unit : null,
      })
    );

    console.log("\n--- STEP 3: Calculating fidelity score with Gemini ---");
    const fidelityResult = await calculateFidelityScore(
      imageBase64,
      ocrText,
      testValues,
      finalHospitalName,
      extractedMetadata.reportDate
    );

    const result: ExtractedReportData = {
      hospitalName: finalHospitalName,
      reportDate: extractedMetadata.reportDate,
      testValues: testValues,
      passed: fidelityResult.passed,
      fidelityScore: fidelityResult.fidelityScore,
      conclusion: fidelityResult.explanation,
    };

    console.log("\n=== FINAL EXTRACTION RESULT ===");
    console.log(`Hospital: ${result.hospitalName}`);
    console.log(`Date: ${result.reportDate}`);
    console.log(`Total Test Values: ${result.testValues.length}`);
    console.log(`Passed: ${result.passed}`);
    console.log(`Fidelity Score: ${result.fidelityScore}`);
    console.log(`Conclusion: ${result.conclusion}`);
    console.log("=== END FINAL EXTRACTION RESULT ===");

    return result;
  } catch (error) {
    console.error("Error in multi-stage AI report extraction:", error);
    return {
      hospitalName: null,
      reportDate: null,
      testValues: [],
      passed: false,
      fidelityScore: 0.0,
      conclusion: null,
    };
  }
}
