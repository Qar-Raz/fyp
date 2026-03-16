"use server";

import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";

const openRouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
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

interface ReportMetadata {
  hospitalName: string | null;
  reportDate: string | null;
  passed: boolean;
}

interface FidelityScoreResult {
  fidelityScore: number;
  explanation: string;
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
// PROMPTS
// ============================================================================

const FIDELITY_SCORE_PROMPT = `You are a quality assurance specialist for medical report processing pipelines. Your task is to evaluate the accuracy and fidelity of an automated medical report extraction system.

You will be provided with:
1. The original medical report image (or first page of PDF)
2. OCR text extracted from the document
3. Extracted key-value pairs from the report
4. Extracted hospital name (if available)
5. Extracted report date (if available)

Your task is to:
1. Compare the extracted data against the original image
2. Evaluate the accuracy of each extracted field
3. Assign a fidelity score from 0.0 to 1.0:
   - 1.0 = Perfect extraction (all fields 100% accurate, no missing data)
   - 0.8-0.9 = Excellent extraction (minor formatting issues, all critical data correct)
   - 0.6-0.7 = Good extraction (some minor errors or omissions)
   - 0.4-0.5 = Fair extraction (several errors or missing important data)
   - 0.2-0.3 = Poor extraction (many errors, significant data missing)
   - 0.0-0.1 = Failed extraction (critical failures, unusable output)

SCORING CRITERIA:
- Key-value pair accuracy: 40% weight
  * Count correctly extracted values vs total values visible in document
  * Penalize incorrect values more than missing values
- Metadata accuracy: 20% weight
  * Hospital name and report date correctness
- Completeness: 20% weight
  * Are all visible values extracted?
  * Are there any obvious omissions?
- Formatting consistency: 10% weight
  * Proper uppercase/lowercase usage
  * Unit consistency
- Overall reliability: 10% weight
  * Would you trust this extraction for medical decisions?

Provide a brief explanation for your score, highlighting specific areas of success or failure.`;

// ============================================================================
// EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extract test values (key-value pairs) using AI
 */
async function extractTestValues(
  ocrText: string
): Promise<ExtractedReportValue[]> {
  console.log("=== STARTING TEST VALUES EXTRACTION ===");

  try {
    const TEST_VALUES_EXTRACTION_PROMPT = `You are a medical test values extraction assistant. Your task is to extract test results from medical/lab reports.

From the provided OCR text of a medical report, extract ALL test values with their names, values, and units.

IMPORTANT RULES:
- If a value has no unit, set unit to null
- Extract ALL test values you can find in the report
- Be precise with numerical values - include decimals exactly as shown
- Common test names include: VITAMIN D, VITAMIN D2, VITAMIN D3, TSH, T3, T4, HBA1C, HEMOGLOBIN, GLUCOSE, CHOLESTEROL, etc.

Analyze the following OCR text and extract the test values:

OCRTEXT:
${ocrText}`;
    const response = await openRouter.chat.completions.create({
      model: "qwen/qwen3.5-9b",
      reasoning_effort: "none",
      temperature: 0,
      messages: [
        {
          role: "user",
          content: TEST_VALUES_EXTRACTION_PROMPT,
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
                description: "Array of extracted test values",
                items: {
                  type: "object",
                  properties: {
                    key: {
                      type: "string",
                      description: "Test name",
                    },
                    value: {
                      type: "string",
                      description: "The numerical or text value of the test",
                    },
                    unit: {
                      type: ["string", "null"],
                      description: "Unit of measurement, or null if none",
                    },
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
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      console.error("No content in test values AI response");
      return [];
    }

    console.log("=== TEST VALUES EXTRACTION RAW RESPONSE ===");
    console.log(content);
    console.log("=== END TEST VALUES EXTRACTION RAW RESPONSE ===");

    const parsed = JSON.parse(content);
    const testValues: ExtractedReportValue[] = parsed.testValues || [];

    // Ensure all keys and units are uppercase (double-check)
    const normalizedTestValues = testValues.map((tv) => ({
      key: tv.key.toUpperCase(),
      value: tv.value,
      unit: tv.unit ? tv.unit : null,
    }));

    console.log("=== PARSED TEST VALUES RESULT ===");
    console.log(`Test Values (${normalizedTestValues.length}):`);
    normalizedTestValues.forEach((tv, i) => {
      console.log(`  ${i + 1}. ${tv.key} = ${tv.value} ${tv.unit || ""}`);
    });
    console.log("=== END PARSED TEST VALUES RESULT ===");

    return normalizedTestValues;
  } catch (error) {
    console.error("Error in test values extraction:", error);
    return [];
  }
}

/**
 * Extract metadata and validate using vision model (Qwen/Qwen-8b-VL)
 */
async function extractMetadataWithVision(
  imageBase64: string,
  ocrText: string,
  testValues: ExtractedReportValue[]
): Promise<ReportMetadata> {
  console.log("=== STARTING VISION METADATA EXTRACTION AND VALIDATION ===");

  try {
    // Prepare the test values summary for the prompt
    const testValuesSummary = testValues
      .map((tv) => `- ${tv.key}: ${tv.value} ${tv.unit || ""}`)
      .join("\n");

    const userContent = `
OCR TEXT:
${ocrText}

EXTRACTED KEY-VALUE PAIRS:
${testValuesSummary || "No values extracted"}

Please analyze the image and extract the hospital name, report date, and validate the extracted key-value pairs.
`;
    const VISION_METADATA_EXTRACTION_PROMPT = `You are a medical report analysis assistant. Your task is to extract metadata and validate previously extracted test values from a medical report image.

You will be provided with:
1. An image of the medical report
2. Key-value pairs that have been extracted from the report

Your task is to:
1. Extract the hospital/laboratory name from the image.
2. Extract the report date from the image.
3. Validate that all provided key-value pairs are 100% correct by cross-referencing with the image.
4. Check that no test values from the image are missing in the extracted data.

CRITICAL RULES:
- Hospital Name: Extract EXACTLY as shown in the document. If not found, return null.
- Report Date: Extract strictly in YYYY-MM-DD format. If not found, return null.
- Validation:
  * Be incredibly strict. 
  * Set "passed" to true ONLY if all key-value pairs are perfectly correct AND complete with no errors or omissions.

OUTPUT FORMAT:
You must respond ONLY with a valid JSON object. Do not include markdown formatting like \`\`\`json. Use this exact schema:
{
  "hospital_name": "String or null",
  "report_date": "YYYY-MM-DD or null",
  "passed": boolean
}

Analyze the provided image and data carefully.

EXTRACTED KEY-VALUE PAIRS TO VALIDATE:
---
${testValuesSummary || "No values extracted"}
---
`;
    const response = await openRouter.chat.completions.create({
      model: "qwen/qwen3.5-9b",
      reasoning_effort: "none",
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: imageBase64,
              },
            },
            {
              type: "text",
              text: VISION_METADATA_EXTRACTION_PROMPT,
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "medical_report_metadata_validation",
          strict: true,
          schema: {
            type: "object",
            properties: {
              hospitalName: {
                type: ["string", "null"],
                description: "Name of the hospital or laboratory.",
              },
              reportDate: {
                type: ["string", "null"],
                description: "Date of the report in YYYY-MM-DD format",
              },
              passed: {
                type: "boolean",
                description:
                  "True only if ALL key-value pairs are 100% correct and complete",
              },
            },
            required: ["hospitalName", "reportDate", "passed"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      console.error("No content in vision metadata AI response");
      return {
        hospitalName: null,
        reportDate: null,
        passed: false,
      };
    }

    console.log("=== VISION METADATA EXTRACTION RAW RESPONSE ===");
    console.log(content);
    console.log("=== END VISION METADATA EXTRACTION RAW RESPONSE ===");

    const metadata: ReportMetadata = JSON.parse(content);

    // Ensure hospital name is uppercase
    if (metadata.hospitalName) {
      metadata.hospitalName = metadata.hospitalName.toUpperCase();
    }

    console.log("=== PARSED VISION METADATA RESULT ===");
    console.log(`Hospital: ${metadata.hospitalName}`);
    console.log(`Date: ${metadata.reportDate}`);
    console.log(`Passed: ${metadata.passed}`);
    console.log("=== END PARSED VISION METADATA RESULT ===");

    return metadata;
  } catch (error) {
    console.error("Error in vision metadata extraction:", error);
    return {
      hospitalName: null,
      reportDate: null,
      passed: false,
    };
  }
}

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

Please analyze the image and extracted data to calculate a fidelity score. Do not deduct points for formatting issues or things being in lower case or upper case. Focus on the accuracy of the extracted values and metadata compared to the image.
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
  "explanation": "<brief explanation of the score>"
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
  };
}

// ============================================================================
// MAIN EXPORT FUNCTION
// ============================================================================

/**
 * Extract structured data from medical report using multi-stage AI pipeline
 *
 * New workflow:
 * 1. Extract test values from OCR text using Qwen
 * 2. Convert PDF to image (if needed) and extract/validate metadata using Qwen Vision
 * 3. Calculate fidelity score using Gemini
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
    // Step 1: Extract test values from OCR text
    console.log("\n--- STEP 1: Extracting test values from OCR text ---");
    const testValues = await extractTestValues(ocrText);

    // Step 2: Prepare image input and extract/validate metadata with vision
    console.log(
      "\n--- STEP 2: Converting to image and extracting metadata with vision ---"
    );
    const imageBase64 = await prepareImageInput(fileBase64, fileType);
    const metadata = await extractMetadataWithVision(
      imageBase64,
      ocrText,
      testValues
    );

    // Step 3: Calculate fidelity score using Gemini
    console.log("\n--- STEP 3: Calculating fidelity score with Gemini ---");
    const fidelityResult = await calculateFidelityScore(
      imageBase64,
      ocrText,
      testValues,
      metadata.hospitalName,
      metadata.reportDate
    );

    const result: ExtractedReportData = {
      hospitalName: metadata.hospitalName,
      reportDate: metadata.reportDate,
      testValues: testValues,
      passed: metadata.passed,
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
