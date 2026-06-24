/**
 * FDA CHECKER WITH IMAGE + IMAGE TEXT EXTRACTION + VECTOR POLICY RULE RETRIEVAL (v02 cleanup)
 *
 * NEW COLUMN MAP (A:G)
 * A = IMAGE (paste the link here)
 * B = CAPTION (paste a text here)
 * C = [blank]
 * D = REVISED IMAGE
 * E = REVISED CAPTION (click "CHECK" to run ▸)
 * F = IMAGE RATIONALE
 * G = CAPTION RATIONALE
 *
 * Mapping:
 *   prompt sheet starts at row 3
 *   system sheet starts at row 2
 *   => prompt row 3 = system row 2
 *
 * WHAT CHANGED:
 *   - Before: fetch all 484 policy_rules and build rules_block from all rows.
 *   - Now: per row, embed caption (or extracted image text) with Gemini Embedding 2,
 *          call Supabase RPC match_policy_rules_vector(),
 *          and build rules_block from only top N relevant rules.
 *   - Schema is the slim policy_rules: id, rule_title, rule_text, fix_note,
 *          src_id, src_locator, src_display, raw_rule_from_src.
 *   - There is no non-vector fallback. Image-only / blank-caption rows extract
 *          image text via Gemini and then run vector retrieval like a caption.
 *
 * REQUIRED SCRIPT PROPERTIES:
 *   GEMINI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_KEY
 *
 * OPTIONAL SCRIPT PROPERTIES:
 *   POLICY_VECTOR_ENABLED              true / false        default true
 *   POLICY_VECTOR_MAX_RULES            50 / 100 / etc      default 100
 *   POLICY_EMBEDDING_MODEL             gemini-embedding-2  default gemini-embedding-2
 *   POLICY_EMBEDDING_DIMENSION         1536                default 1536
 *   POLICY_EMBEDDING_MODEL_DB_NAME     gemini-embedding-2:1536
 *
 * IMPORTANT:
 *   - You must already run the SQL init file.
 *   - You must already backfill public.policy_rule_embeddings.
 *   - The embedding model DB name used during backfill must match POLICY_EMBEDDING_MODEL_DB_NAME.
 */

const SUPABASE_URL = PropertiesService.getScriptProperties().getProperty("SUPABASE_URL");
const SUPABASE_KEY = PropertiesService.getScriptProperties().getProperty("SUPABASE_KEY");
const NO_CAPTION_IMAGE_ONLY_MESSAGE = "[no caption, only image]";
const REPAIR_MANUAL_REVIEW_ENABLED = false;

// Fail issues whose rule_id is in this list are treated as background/context only:
// they are dropped after the model returns its fail list (same flow as the old
// priority==50 hard filter). Paste policy_rules.id (UUID) values here to suppress.
const HARD_FILTER_RULE_IDS = [
  // "00000000-0000-0000-0000-000000000000",
];

function PolicyChecker_inDev_forADwithIMG() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const promptSheet = ss.getSheetByName("promptMaster for [IMG and CAPTION]");
  const systemSheet = ss.getSheetByName("IMG and CAPTION");

  Logger.log("=== PolicyChecker_inDev_forADwithIMG START ===");

  if (!promptSheet) throw new Error('Sheet not found: promptMaster for [IMG and CAPTION]');
  if (!systemSheet) throw new Error('Sheet not found: IMG and CAPTION');
  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!SUPABASE_KEY) throw new Error("Missing SUPABASE_KEY");

  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const retrievalConfig = getPolicyRetrievalConfig_();

  const modelId = "gemini-3-flash-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const maxGeminiAttempts = 5;
  const geminiTemperature = 1.0;
  const geminiSeed = 42;

  const promptDataRows = Math.max(promptSheet.getLastRow() - 2, 0); // starts row 3
  const systemDataRows = Math.max(systemSheet.getLastRow() - 1, 0); // starts row 2
  const totalRows = Math.max(promptDataRows, systemDataRows);

  Logger.log(`Prompt data rows = ${promptDataRows}`);
  Logger.log(`System data rows = ${systemDataRows}`);
  Logger.log(`Total rows to process = ${totalRows}`);
  Logger.log(`Policy vector retrieval enabled = ${retrievalConfig.enabled}`);
  Logger.log(`Policy vector max rules = ${retrievalConfig.maxRules}`);
  Logger.log(`Policy embedding model = ${retrievalConfig.embeddingModel}`);
  Logger.log(`Policy embedding dimension = ${retrievalConfig.embeddingDimension}`);
  Logger.log(`Policy embedding DB name = ${retrievalConfig.embeddingModelDbName}`);

  if (totalRows <= 0) {
    Logger.log("No rows to process.");
    Logger.log("=== PolicyChecker_inDev_forADwithIMG END ===");
    return;
  }

  Logger.log("=== PHASE 1: FACEBOOK SCRAPE SKIPPED ===");
  Logger.log("=== PHASE 2: ASSESS START ===");

  const quickReferenceBlock = buildQuickReferenceBlock_();
  const rulesBlockCache = {};

  Logger.log(`quickReferenceBlock length = ${quickReferenceBlock.length}`);

  const assessCtx = {
    promptSheet: promptSheet,
    systemSheet: systemSheet,
    retrievalConfig: retrievalConfig,
    quickReferenceBlock: quickReferenceBlock,
    rulesBlockCache: rulesBlockCache,
    url: url,
    maxGeminiAttempts: maxGeminiAttempts,
    geminiTemperature: geminiTemperature,
    geminiSeed: geminiSeed
  };

  for (let i = 0; i < totalRows; i++) {
    processAssessRow_(assessCtx, i);
  }

  Logger.log("=== PHASE 2: ASSESS END ===");
  Logger.log("=== PolicyChecker_inDev_forADwithIMG END ===");
}

function processAssessRow_(ctx, rowIndex) {
  const promptRow = rowIndex + 3;
  const systemRow = rowIndex + 2;
  const promptSheet = ctx.promptSheet;
  const systemSheet = ctx.systemSheet;

  let prompt = promptSheet.getRange(promptRow, 1).getValue();
  const rowValues = systemSheet.getRange(systemRow, 1, 1, 2).getValues()[0];

  const cleanImageUrl1 = toCleanString_(rowValues[0]);
  let cleanCaption = toCleanString_(rowValues[1]);

  const forceImageOnlyFromPrompt = promptIndicatesImageOnly_(prompt);

  if (forceImageOnlyFromPrompt) {
    Logger.log(`System row ${systemRow}: prompt indicates image-only mode`);
    cleanCaption = "";
    prompt = removeImageOnlySentinelFromPrompt_(prompt);
  }

  Logger.log("");
  Logger.log(`--- PHASE 2 | Prompt Row ${promptRow} | System Row ${systemRow} ---`);

  if (!cleanCaption && !cleanImageUrl1) {
    Logger.log(`System row ${systemRow} skipped: no caption and no image`);
    return;
  }

  const promptHasInlineMessage = promptContainsMessagePlaceholder_(prompt);
  const cleanPrompt = buildPromptText_(prompt, {
    rulesBlock: "",
    quickReferenceBlock: ctx.quickReferenceBlock,
    message: cleanCaption
  });

  Logger.log(`Prompt raw value: [${prompt}]`);
  Logger.log(`Prompt cleaned value length: ${cleanPrompt.length}`);
  Logger.log(`Caption exists: ${!!cleanCaption}`);
  Logger.log(`Image URL exists: ${!!cleanImageUrl1}`);
  Logger.log(`Prompt has inline message placeholder: ${promptHasInlineMessage}`);

  if (!cleanPrompt || cleanPrompt.toUpperCase() === "N/A") {
    Logger.log(`Prompt row ${promptRow} skipped: empty/N/A prompt`);
    return;
  }

  let mode = "none";
  let imageFetchNoticeText = "";

  try {
    clearAssessOutputRow_(systemSheet, systemRow);

    const fetchResult = fetchImagesForAssessRow_(cleanImageUrl1, systemRow);
    const imageFetchIssues = fetchResult.imageFetchIssues;
    const imageParts = fetchResult.imageParts;
    const attachedImageCount = fetchResult.attachedImageCount;

    imageFetchNoticeText = formatImageFetchIssuesForRevisedImageCell_(imageFetchIssues);
    mode = forceImageOnlyFromPrompt
      ? resolveAnalysisMode_(false, attachedImageCount)
      : resolveAnalysisMode_(!!cleanCaption, attachedImageCount);

    Logger.log(`System row ${systemRow}: mode = ${mode}`);
    Logger.log(`System row ${systemRow}: attachedImageCount = ${attachedImageCount}`);
    Logger.log(`System row ${systemRow}: imageFetchIssues = ${imageFetchIssues.length}`);

    if (mode === "none") {
      Logger.log(`System row ${systemRow}: no assessable caption or image after fetch`);
      writeAssessOutputRow_(systemSheet, systemRow, {
        revisedImage: imageFetchNoticeText,
        revisedCaption: "",
        imageRationale: "",
        captionRationale: ""
      });
      return;
    }

    let rowPolicyRows;
    try {
      rowPolicyRows = getPolicyRulesForAssessMode_({
        mode: mode,
        cleanCaption: cleanCaption,
        retrievalConfig: ctx.retrievalConfig,
        cache: ctx.rulesBlockCache,
        systemRow: systemRow,
        imageParts: imageParts,
        attachedImageCount: attachedImageCount,
        geminiUrl: ctx.url
      });
    } catch (retrievalErr) {
      Logger.log(`System row ${systemRow}: policy retrieval failed -> ${retrievalErr.message}`);
      writeRowOutputError_(systemSheet, systemRow, mode, "caption", {
        revisedImage: imageFetchNoticeText,
        title: "VECTOR RETRIEVAL FAILED",
        detail: retrievalErr.message
      });
      return;
    }

    const rowRulesBlock = buildRulesBlock_(rowPolicyRows, {
      maxRules: ctx.retrievalConfig.maxRules
    });

    Logger.log(`System row ${systemRow}: retrieved policy rules = ${rowPolicyRows.length}`);
    Logger.log(`System row ${systemRow}: rowRulesBlock length = ${rowRulesBlock.length}`);
    logPolicyRulesSummary_(systemRow, rowPolicyRows);

    const assessPrompt = buildPromptText_(prompt, {
      rulesBlock: rowRulesBlock,
      quickReferenceBlock: ctx.quickReferenceBlock,
      message: cleanCaption
    });

    const processingStatus = makeProcessingStatus_(mode, imageFetchNoticeText);
    writeAssessOutputRow_(systemSheet, systemRow, {
      revisedImage: processingStatus[0],
      revisedCaption: processingStatus[1],
      imageRationale: processingStatus[2],
      captionRationale: processingStatus[3]
    });

    Logger.log(`System row ${systemRow}: set processing status for mode=${mode}`);

    let effectiveMode = mode;
    let effectiveRulesBlock = rowRulesBlock;
    let effectivePolicyRows = rowPolicyRows;
    let geminiImageNoticeText = "";
    let geminiImageRationaleText = "";
    let usedCaptionOnlyFallback = false;

    let payload = buildAssessGeminiPayload_({
      mode: mode,
      assessPrompt: assessPrompt,
      cleanCaption: cleanCaption,
      promptHasInlineMessage: promptHasInlineMessage,
      imageParts: imageParts,
      attachedImageCount: attachedImageCount,
      ctx: ctx
    });

    let geminiRun = callGeminiWithRetry_(
      ctx.url,
      payload,
      systemRow,
      ctx.maxGeminiAttempts
    );

    if (
      !geminiRun.ok &&
      mode === "both" &&
      isGeminiUnprocessableImageError_(geminiRun)
    ) {
      geminiImageNoticeText = formatGeminiImageProcessingNotice_(geminiRun);
      geminiImageRationaleText = formatGeminiImageProcessingRationale_(geminiRun);

      if (cleanCaption) {
        Logger.log(`System row ${systemRow}: caption-only fallback triggered`);

        usedCaptionOnlyFallback = true;
        effectiveMode = "caption_only";

        const fallbackPolicyRows = getPolicyRulesForAssessMode_({
          mode: "caption_only",
          cleanCaption: cleanCaption,
          retrievalConfig: ctx.retrievalConfig,
          cache: ctx.rulesBlockCache,
          systemRow: systemRow,
          imageParts: imageParts,
          attachedImageCount: attachedImageCount,
          geminiUrl: ctx.url
        });

        effectiveRulesBlock = buildRulesBlock_(fallbackPolicyRows, {
          maxRules: ctx.retrievalConfig.maxRules
        });
        effectivePolicyRows = fallbackPolicyRows;

        const fallbackAssessPrompt = buildPromptText_(prompt, {
          rulesBlock: effectiveRulesBlock,
          quickReferenceBlock: ctx.quickReferenceBlock,
          message: cleanCaption
        });

        payload = buildAssessGeminiPayload_({
          mode: "caption_only",
          assessPrompt: fallbackAssessPrompt,
          cleanCaption: cleanCaption,
          promptHasInlineMessage: promptHasInlineMessage,
          imageParts: [],
          attachedImageCount: 0,
          ctx: ctx
        });

        geminiRun = callGeminiWithRetry_(
          ctx.url,
          payload,
          systemRow,
          ctx.maxGeminiAttempts
        );
      } else {
        Logger.log(
          `System row ${systemRow}: Gemini image processing error with no caption -> image columns only`
        );
        writeRowOutputError_(systemSheet, systemRow, "image_only", "image", {
          revisedImage: geminiImageNoticeText || imageFetchNoticeText,
          title: geminiRun.title,
          detail: geminiImageRationaleText || geminiRun.detail
        });
        return;
      }
    }

    if (!geminiRun.ok) {
      Logger.log(
        `System row ${systemRow}: final failure after ${geminiRun.attemptUsed}/${ctx.maxGeminiAttempts} attempts -> ${geminiRun.title}`
      );

      if (
        !usedCaptionOnlyFallback &&
        mode === "image_only" &&
        isGeminiUnprocessableImageError_(geminiRun)
      ) {
        const imageNotice = formatGeminiImageProcessingNotice_(geminiRun);
        const preservedImage = [imageNotice, imageFetchNoticeText].filter(Boolean).join("\n\n");
        writeRowOutputError_(systemSheet, systemRow, "image_only", "image", {
          revisedImage: preservedImage,
          title: geminiRun.title,
          detail: formatGeminiImageProcessingRationale_(geminiRun)
        });
        return;
      }

      const errorScope = usedCaptionOnlyFallback
        ? "caption"
        : inferGeminiErrorScope_(mode);

      const preservedImage = usedCaptionOnlyFallback
        ? [geminiImageNoticeText, imageFetchNoticeText].filter(Boolean).join("\n\n")
        : imageFetchNoticeText;

      writeRowOutputError_(systemSheet, systemRow, effectiveMode, errorScope, {
        revisedImage: preservedImage,
        title: geminiRun.title,
        detail: geminiRun.detail
      });

      if (usedCaptionOnlyFallback && geminiImageRationaleText) {
        systemSheet.getRange(systemRow, 6).setValue(geminiImageRationaleText);
        SpreadsheetApp.flush();
      }

      return;
    }

    Logger.log(
      `System row ${systemRow}: Gemini success on attempt ${geminiRun.attemptUsed}/${ctx.maxGeminiAttempts}` +
      (usedCaptionOnlyFallback ? " (caption-only fallback)" : "")
    );

    const result = geminiRun.result || {};
    const captionAnalysis = extractAnalysisObject_(result, "caption_analysis");
    const imageAnalysis = extractAnalysisObject_(result, "image_analysis");
    const imageFetchErrorStrings = imageFetchIssuesToErrorStrings_(imageFetchIssues);

    let revisedImageText = "";
    let revisedCaption = "";
    let imageRationale = "";
    let captionRationale = "";

    if (usedCaptionOnlyFallback) {
      revisedImageText = geminiImageNoticeText;
      imageRationale = geminiImageRationaleText;
    } else if (effectiveMode === "both" || effectiveMode === "image_only") {
      if (isPassOrZeroFailAnalysis_(imageAnalysis)) {
        revisedImageText = buildPassRevisedTextForSheet_(imageAnalysis);
        imageRationale = buildPassRationaleText_(imageAnalysis);
      } else {
        revisedImageText = formatRevisedImageTextCell_(imageAnalysis);
        imageRationale = formatImageRationale_(imageAnalysis, imageFetchErrorStrings);
      }
    }

    if (effectiveMode === "both" || effectiveMode === "caption_only") {
      if (isPassOrZeroFailAnalysis_(captionAnalysis)) {
        revisedCaption = buildPassRevisedTextForSheet_(captionAnalysis);
        captionRationale = buildPassRationaleText_(captionAnalysis);
      } else {
        revisedCaption = getBestRevisedMessageFromAnalysis_(captionAnalysis);
        captionRationale = formatCaptionRationale_(captionAnalysis);

        const verifyResult = ensureRevisedCaptionPass_({
          url: ctx.url,
          rawPrompt: prompt,
          rulesBlock: effectiveRulesBlock,
          quickReferenceBlock: ctx.quickReferenceBlock,
          originalCaption: cleanCaption,
          initialRevisedCaption: revisedCaption,
          systemRow: systemRow,
          maxGeminiAttempts: ctx.maxGeminiAttempts,
          geminiTemperature: ctx.geminiTemperature,
          geminiSeed: ctx.geminiSeed,
          maxRepairRounds: 3
        });

        revisedCaption = verifyResult.finalCaption;
      }
    }

    if (imageFetchNoticeText) {
      revisedImageText = revisedImageText
        ? revisedImageText + "\n\n" + imageFetchNoticeText
        : imageFetchNoticeText;
    }

    Logger.log(`System row ${systemRow}: revisedImageText length = ${revisedImageText.length}`);
    Logger.log(`System row ${systemRow}: revisedCaption length = ${revisedCaption.length}`);
    Logger.log(`System row ${systemRow}: imageRationale length = ${imageRationale.length}`);
    Logger.log(`System row ${systemRow}: captionRationale length = ${captionRationale.length}`);

    writeAssessOutputRow_(systemSheet, systemRow, {
      revisedImage: revisedImageText,
      revisedCaption: revisedCaption,
      imageRationale: imageRationale,
      captionRationale: captionRationale
    });

    Logger.log(`System row ${systemRow}: DONE`);
  } catch (e) {
    Logger.log(`Error on prompt row ${promptRow} / system row ${systemRow}: ${e.message}`);
    const errorMode = mode === "none"
      ? resolveAnalysisMode_(!!cleanCaption, 0)
      : mode;
    writeRowOutputError_(systemSheet, systemRow, errorMode, inferGeminiErrorScope_(errorMode), {
      revisedImage: imageFetchNoticeText,
      title: "SCRIPT ERROR",
      detail: e.message
    });
  }
}

function fetchImagesForAssessRow_(cleanImageUrl1, systemRow) {
  const imageUrls = [cleanImageUrl1].filter(Boolean);
  const imageParts = [];
  const imageFetchIssues = [];
  let attachedImageCount = 0;

  for (let j = 0; j < imageUrls.length; j++) {
    const imageUrl = imageUrls[j];

    Logger.log(`System row ${systemRow}: fetching image #${j + 1} blob...`);

    const fetchResult = fetchImageBlobSafely_(imageUrl);

    if (!fetchResult.ok || !fetchResult.mimeType) {
      const issue = {
        imageNumber: j + 1,
        sourceType: fetchResult.sourceType || "external_url",
        errorKind: fetchResult.errorKind || "unknown_image_fetch_failed",
        userMessage: fetchResult.userMessage || "ไม่สามารถดึงรูปภาพจากลิงก์นี้ได้",
        technicalMessage: fetchResult.technicalMessage || ""
      };

      imageFetchIssues.push(issue);

      Logger.log(
        `System row ${systemRow}: Image #${j + 1} fetch failed | ` +
        `${issue.errorKind} | ${issue.technicalMessage}`
      );

      continue;
    }

    const blob = fetchResult.blob;
    const bytes = blob.getBytes();
    const mimeType = fetchResult.mimeType;

    attachedImageCount += 1;

    Logger.log(`System row ${systemRow}: image #${j + 1} fetched successfully`);
    Logger.log(
      `System row ${systemRow}: attached as IMAGE ${attachedImageCount}, ` +
      `validated mimeType=${mimeType}, hexPreview=${bytesHexPreview_(bytes, 12)}, bytes=${bytes.length}`
    );

    imageParts.push({
      text: `[IMAGE ${attachedImageCount}]`
    });

    imageParts.push({
      inline_data: {
        mime_type: mimeType,
        data: Utilities.base64Encode(bytes)
      }
    });
  }

  return {
    imageParts: imageParts,
    imageFetchIssues: imageFetchIssues,
    attachedImageCount: attachedImageCount
  };
}

function getPolicyRulesForAssessMode_(args) {
  const mode = args.mode;
  const cleanCaption = toCleanString_(args.cleanCaption);
  const retrievalConfig = args.retrievalConfig || getPolicyRetrievalConfig_();
  const cache = args.cache || {};
  const systemRow = args.systemRow || "-";
  const imageParts = Array.isArray(args.imageParts) ? args.imageParts : [];
  const attachedImageCount = Number(args.attachedImageCount) || 0;
  const geminiUrl = args.geminiUrl;

  let retrievalText = cleanCaption;

  // No caption text to embed (image_only or blank caption with images attached):
  // extract the visible text from the image(s) and use it as the retrieval query,
  // exactly like a caption.
  if (!retrievalText && attachedImageCount > 0 && geminiUrl) {
    Logger.log(`System row ${systemRow}: no caption; extracting image text for vector retrieval`);
    retrievalText = extractImageTextForRetrieval_({
      geminiUrl: geminiUrl,
      imageParts: imageParts,
      attachedImageCount: attachedImageCount,
      systemRow: systemRow
    });
    Logger.log(`System row ${systemRow}: extracted image text length = ${retrievalText.length}`);
  }

  return getRelevantPolicyRulesForRow_({
    retrievalText: retrievalText,
    retrievalConfig: retrievalConfig,
    cache: cache,
    systemRow: systemRow
  });
}

function extractImageTextForRetrieval_(args) {
  const geminiUrl = args.geminiUrl;
  const imageParts = Array.isArray(args.imageParts) ? args.imageParts : [];
  const attachedImageCount = Number(args.attachedImageCount) || 0;
  const systemRow = args.systemRow || "-";

  if (!geminiUrl || attachedImageCount <= 0 || !imageParts.length) {
    return "";
  }

  const instruction =
    "Extract ALL visible text from the attached image(s) exactly as written, " +
    "including Thai and English text, captions, headlines, overlays, watermarks, " +
    "disclaimers, fine print, and any numbers or prices. " +
    "Output only the raw extracted text with no commentary, no labels, and no formatting. " +
    "If there is no readable text, output an empty string.";

  const parts = [{ text: instruction }];
  for (let k = 0; k < imageParts.length; k++) {
    parts.push(imageParts[k]);
  }

  const payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "text/plain"
    }
  };

  const res = UrlFetchApp.fetch(geminiUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const raw = res.getContentText();

  if (code < 200 || code >= 300) {
    Logger.log(`System row ${systemRow}: image text extraction failed (${code}): ${safeSlice_(raw, 500)}`);
    return "";
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    Logger.log(`System row ${systemRow}: image text extraction JSON parse error`);
    return "";
  }

  const candidateParts = ((((json.candidates || [])[0] || {}).content || {}).parts || []);
  const fullText = candidateParts
    .map(function(part) { return part && part.text ? part.text : ""; })
    .join("\n")
    .trim();

  return toCleanString_(fullText);
}

function logPolicyRulesSummary_(systemRow, rowPolicyRows) {
  const debugRaw = String(
    PropertiesService.getScriptProperties().getProperty("POLICY_DEBUG_LOG") || ""
  ).toLowerCase();
  const debugEnabled = debugRaw === "true" || debugRaw === "1" || debugRaw === "yes";

  if (!debugEnabled) {
    const preview = (rowPolicyRows || []).slice(0, 3).map(function(r) {
      return r.rule_id || r.id || "?";
    });
    Logger.log(
      `System row ${systemRow}: policy rules preview (first 3 ids) = ${preview.join(", ")}`
    );
    return;
  }

  Logger.log(
    JSON.stringify(
      (rowPolicyRows || []).slice(0, 10).map(function(r) {
        return {
          rule_id: r.rule_id || r.id,
          match_source: r.match_source || "",
          similarity: r.similarity || "",
          distance: r.distance || "",
          rule_title: r.rule_title || "",
          src_display: r.src_display || "",
          src_locator: r.src_locator || ""
        };
      }),
      null,
      2
    )
  );
}

function imageFetchIssuesToErrorStrings_(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return list.map(function(issue, index) {
    const imageNo = (issue && issue.imageNumber) || (index + 1);
    const userMessage = (issue && issue.userMessage) || "ไม่สามารถดึงรูปภาพจากลิงก์นี้ได้";
    const technicalMessage = (issue && issue.technicalMessage) || "";
    return `Image #${imageNo}: ${userMessage} | ${technicalMessage}`;
  });
}

function inferGeminiErrorScope_(mode) {
  if (mode === "caption_only") return "caption";
  if (mode === "image_only") return "image";
  return "all";
}

function isGeminiUnprocessableImageError_(run) {
  if (!run || run.ok) {
    return false;
  }

  const title = String(run.title || "");
  const detail = String(run.detail || "");
  const responseCode = Number(run.responseCode);

  const is400 = responseCode === 400 || /API ERROR \(400\)/i.test(title);
  if (!is400) {
    return false;
  }

  return (
    /Unable to process input image/i.test(detail) ||
    /INVALID_ARGUMENT/i.test(detail)
  );
}

function formatGeminiImageProcessingNotice_(run) {
  const title = toCleanString_(run && run.title) || "API ERROR (400)";
  return [
    "ไม่สามารถตรวจรูปภาพที่แนบได้",
    "",
    "Gemini ไม่สามารถประมวลผลรูปภาพนี้ได้ แม้ระบบดึงไฟล์มาได้แล้ว",
    "- สาเหตุที่เป็นไปได้: ไฟล์เสียหาย, รูปแบบไม่รองรับ, หรือเนื้อหารูปไม่สามารถอ่านได้",
    "- วิธีแก้: ใช้ลิงก์รูป JPG / PNG / WEBP / GIF ที่เปิดได้จริง หรืออัปโหลดรูปใหม่ใน Google Drive",
    "",
    "ระบบจะตรวจข้อความแคปชันแทน (ถ้ามี)",
    "",
    `รายละเอียด: ${title}`
  ].join("\n");
}

function formatGeminiImageProcessingRationale_(run) {
  const detail = toCleanString_(run && run.detail);
  const lines = [
    "เกิดข้อผิดพลาดระหว่างประมวลผลรูปภาพ",
    "",
    "Gemini ตอบกลับว่าไม่สามารถประมวลผลรูปภาพที่แนบได้",
    "- อาจเกิดจากไฟล์เสียหาย, รูปแบบไม่รองรับ, หรือเนื้อหารูปไม่สามารถอ่านได้",
    "- โปรดตรวจสอบลิงก์รูปภาพแล้วลองรันใหม่อีกครั้ง"
  ];

  if (detail) {
    lines.push("");
    lines.push("รายละเอียดทางเทคนิค:");
    lines.push(safeSlice_(detail, 1200));
  }

  return lines.join("\n");
}

function buildAssessGeminiPayload_(args) {
  args = args || {};

  const mode = args.mode || "caption_only";
  const assessPrompt = args.assessPrompt || "";
  const cleanCaption = args.cleanCaption || "";
  const promptHasInlineMessage = !!args.promptHasInlineMessage;
  const imageParts = Array.isArray(args.imageParts) ? args.imageParts : [];
  const attachedImageCount = Number(args.attachedImageCount) || 0;
  const ctx = args.ctx || {};

  const parts = [{
    text: assessPrompt + "\n\n" + buildTaskInstruction_(mode)
  }];

  if (
    cleanCaption &&
    (mode === "both" || mode === "caption_only") &&
    !promptHasInlineMessage
  ) {
    parts.push({
      text: `[CAPTION]\n${cleanCaption}`
    });
  }

  if (mode === "both" || mode === "image_only") {
    parts.push({
      text: `[ATTACHED_IMAGE_COUNT]\n${attachedImageCount}`
    });

    for (let k = 0; k < imageParts.length; k++) {
      parts.push(imageParts[k]);
    }
  }

  return {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: ctx.geminiTemperature,
      seed: ctx.geminiSeed,
      maxOutputTokens: 50000,
      responseMimeType: "application/json",
      responseSchema: buildFDAResponseSchema_(mode)
    }
  };
}

function clearAssessOutputRow_(sheet, row) {
  sheet.getRange(row, 4, 1, 4).clearContent();
  sheet.getRange(row, 4, 1, 4)
    .setVerticalAlignment("top")
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  SpreadsheetApp.flush();
  Logger.log(`System row ${row}: cleared old outputs`);
}

function writeAssessOutputRow_(sheet, row, output) {
  output = output || {};
  sheet.getRange(row, 4, 1, 4).setValues([[
    output.revisedImage || "",
    output.revisedCaption || "",
    output.imageRationale || "",
    output.captionRationale || ""
  ]]);

  sheet.getRange(row, 4, 1, 4)
    .setVerticalAlignment("top")
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);

  SpreadsheetApp.flush();
}

/* =====================================================================
 * VECTOR POLICY RETRIEVAL
 * ===================================================================== */

function getPolicyRetrievalConfig_() {
  const props = PropertiesService.getScriptProperties();

  const enabledRaw = String(props.getProperty("POLICY_VECTOR_ENABLED") || "true").toLowerCase();
  const enabled = enabledRaw !== "false" && enabledRaw !== "0" && enabledRaw !== "no";

  const maxRules = clampInt_(
    props.getProperty("POLICY_VECTOR_MAX_RULES"),
    100,
    10,
    300
  );

  const embeddingModel = props.getProperty("POLICY_EMBEDDING_MODEL") || "gemini-embedding-2";
  const embeddingDimension = clampInt_(
    props.getProperty("POLICY_EMBEDDING_DIMENSION"),
    1536,
    128,
    3072
  );

  const embeddingModelDbName =
    props.getProperty("POLICY_EMBEDDING_MODEL_DB_NAME") ||
    `${embeddingModel}:${embeddingDimension}`;

  return {
    enabled,
    maxRules,
    embeddingModel,
    embeddingDimension,
    embeddingModelDbName
  };
}

function clampInt_(value, defaultValue, minValue, maxValue) {
  const n = Number(value);
  if (!isFinite(n)) return defaultValue;
  return Math.min(Math.max(Math.floor(n), minValue), maxValue);
}

function getRelevantPolicyRulesForRow_(args) {
  const retrievalText = toCleanString_(args.retrievalText);
  const retrievalConfig = args.retrievalConfig || getPolicyRetrievalConfig_();
  const cache = args.cache || {};
  const systemRow = args.systemRow || "-";

  if (!retrievalText) {
    throw new Error(
      `Vector retrieval requires text but none was available for system row ${systemRow} ` +
      `(no caption and no extractable image text).`
    );
  }

  const cacheKey = [
    retrievalConfig.embeddingModelDbName,
    retrievalConfig.maxRules,
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      retrievalText,
      Utilities.Charset.UTF_8
    ).map(function(b) {
      return (b + 256).toString(16).slice(-2);
    }).join("")
  ].join("|");

  if (cache[cacheKey]) {
    Logger.log(`System row ${systemRow}: policy retrieval cache hit`);
    return cache[cacheKey];
  }

  Logger.log(`System row ${systemRow}: creating Gemini embedding for policy retrieval`);
  const embedding = createGeminiEmbeddingForPolicySearch_(retrievalText, retrievalConfig);

  Logger.log(`System row ${systemRow}: calling Supabase match_policy_rules_vector`);
  const rows = matchPolicyRulesVector_({
    embedding,
    retrievalConfig
  });

  if (!rows || !rows.length) {
    throw new Error(
      `Vector retrieval returned 0 rows. Check POLICY_EMBEDDING_MODEL_DB_NAME=${retrievalConfig.embeddingModelDbName} and policy_rule_embeddings data.`
    );
  }

  cache[cacheKey] = rows;
  return rows;
}

function createGeminiEmbeddingForPolicySearch_(text, retrievalConfig) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const model = retrievalConfig.embeddingModel || "gemini-embedding-2";
  const dimension = retrievalConfig.embeddingDimension || 1536;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;

  // Gemini Embedding 2 does not use task_type. Put the task instruction in text.
  const embeddingText = [
    "task: search result | query:",
    "Retrieve advertising policy rules and Thai legal compliance rules relevant to this Facebook ad/post content.",
    "",
    text
  ].join("\n");

  const payload = {
    model: `models/${model}`,
    content: {
      parts: [
        {
          text: embeddingText
        }
      ]
    },
    output_dimensionality: dimension
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-goog-api-key": apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Gemini embedding failed (${code}): ${body}`);
  }

  const json = JSON.parse(body);
  const values =
    (json.embedding && json.embedding.values) ||
    (json.embeddings && json.embeddings[0] && json.embeddings[0].values);

  if (!values || !Array.isArray(values)) {
    throw new Error(`Gemini embedding response missing values: ${body}`);
  }

  if (values.length !== dimension) {
    throw new Error(`Embedding dimension mismatch: got ${values.length}, expected ${dimension}`);
  }

  return values.map(Number);
}

function matchPolicyRulesVector_(args) {
  const embedding = args.embedding || [];
  const retrievalConfig = args.retrievalConfig || getPolicyRetrievalConfig_();

  const url = `${SUPABASE_URL}/rest/v1/rpc/match_policy_rules_vector`;
  const vectorLiteral = "[" + embedding.map(Number).join(",") + "]";

  const payload = {
    query_embedding: vectorLiteral,
    match_count: retrievalConfig.maxRules,
    embedding_model_filter: retrievalConfig.embeddingModelDbName,

    // Accepted but ignored by the new RPC (kept for backward-compatible signature).
    policy_type_filter: null,
    rule_status_filter: null
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer": "return=representation"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Supabase match_policy_rules_vector failed (${code}): ${text}`);
  }

  return JSON.parse(text);
}

/* =====================================================================
 * PROMPT + MODE HELPERS
 * ===================================================================== */

function buildPromptText_(prompt, data) {
  data = data || {};

  const originalPrompt = String(prompt || "");
  let out = originalPrompt;

  out = out.replace(/{{\s*rules_block\s*}}/gi, function() {
    return data.rulesBlock || "";
  });

  out = out.replace(/{{\s*quick_reference_block\s*}}/gi, function() {
    return data.quickReferenceBlock || "{}";
  });

  out = out.replace(/{{\s*message\s*}}/gi, function() {
    return data.message || "";
  });

  out = out.replace(/{{\s*Message\s*}}/g, function() {
    return data.message || "";
  });

  out = out.replace(/{{\s*ExistingPost\s*}}/g, "");
  out = out.replace(/{{\s*ImageCount\s*}}/g, "");

  return out.trim();
}

function promptContainsMessagePlaceholder_(prompt) {
  return /{{\s*message\s*}}/i.test(String(prompt || ""));
}

function promptIndicatesImageOnly_(prompt) {
  return String(prompt || "")
    .toLowerCase()
    .indexOf(NO_CAPTION_IMAGE_ONLY_MESSAGE.toLowerCase()) !== -1;
}

function removeImageOnlySentinelFromPrompt_(prompt) {
  return String(prompt || "")
    .replaceAll(NO_CAPTION_IMAGE_ONLY_MESSAGE, "")
    .trim();
}

function resolveAnalysisMode_(hasCaption, attachedImageCount) {
  if (hasCaption && attachedImageCount > 0) return "both";
  if (hasCaption) return "caption_only";
  if (attachedImageCount > 0) return "image_only";
  return "none";
}

function buildTaskInstruction_(mode) {
  if (mode === "caption_only") {
    return [
      "IMPORTANT TASK MODE: CAPTION_ONLY",
      "- Analyze ONLY the caption.",
      "- No usable image was attached.",
      "- For this Apps Script integration, return a JSON object with ONLY the key `caption_analysis`.",
      "- `caption_analysis` must use pass/fail only.",
      "- Include `spell_check` inside `caption_analysis`.",
      "- If spelling issues are found, put them in `spell_check.items`.",
      "- Spell check is editorial only; it must NOT change `overall_result` or `summary.overall_verdict`.",
      "- Count spelling issues together with policy issues in `summary.issue_count` and `summary.fail_count`.",
      "- Do not duplicate spelling issues into `issues`; the Apps Script formatter will merge them into the final displayed fail list.",
      "- Return ONLY `caption_analysis`.",
      "- Do NOT fabricate or infer any image analysis."
    ].join("\n");
  }

  if (mode === "image_only") {
    return [
      "IMPORTANT TASK MODE: IMAGE_ONLY",
      "- Analyze ONLY the attached image(s).",
      "- No caption was provided.",
      "- For this Apps Script integration, return a JSON object with ONLY the key `image_analysis`.",
      "- `image_analysis` must use pass/fail only.",
      "- Include `spell_check` inside `image_analysis` for extracted image text when available.",
      "- Spell check must not affect `overall_result`, `fail_count`, `issue_count`, or `issues`.",
      "- Return ONLY `image_analysis`.",
      "- Do NOT fabricate or infer any caption analysis."
    ].join("\n");
  }

  return [
    "IMPORTANT TASK MODE: BOTH",
    "- Analyze both the caption and the attached image(s).",
    "- For this Apps Script integration, return a JSON object with BOTH `caption_analysis` and `image_analysis`.",
    "- Both analysis objects must use pass/fail only.",
    "- Include `spell_check` inside both `caption_analysis` and `image_analysis`.",
    "- Spell check must not affect `overall_result`, `fail_count`, `issue_count`, or `issues`.",
    "- Return BOTH `caption_analysis` and `image_analysis`."
  ].join("\n");
}

function makeProcessingStatus_(mode, revisedImageNotice) {
  const imageNotice = toCleanString_(revisedImageNotice);
  let status;

  if (mode === "caption_only") {
    status = [
      "",
      "PROCESSING CAPTION...",
      "",
      "PROCESSING CAPTION..."
    ];
  } else if (mode === "image_only") {
    status = [
      "PROCESSING IMAGE TEXT...",
      "",
      "PROCESSING IMAGE...",
      ""
    ];
  } else {
    status = [
      "PROCESSING IMAGE TEXT...",
      "PROCESSING CAPTION...",
      "PROCESSING IMAGE...",
      "PROCESSING CAPTION..."
    ];
  }

  if (imageNotice) {
    status[0] = imageNotice;
  }

  return status;
}

/* =====================================================================
 * VERIFY / REPAIR LOOP
 * ===================================================================== */

function isNeedsManualReviewText_(text) {
  const s = toCleanString_(text).toLowerCase();

  return (
    /needs\s+manual\s+review/i.test(s) ||
    /manual\s+review/i.test(s) ||
    /กรุณาดูคำแนะนำเพิ่มเติมใน rationale/i.test(s) ||
    /ต้องตรวจสอบด้วยตนเอง/i.test(s)
  );
}

function pickLatestCaptionWithoutManualReview_(lastCandidate, initialCandidate, originalCaption) {
  const candidates = [
    lastCandidate,
    initialCandidate,
    originalCaption
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = toCleanString_(candidates[i]);
    if (c && !isNeedsManualReviewText_(c)) {
      return c;
    }
  }

  // fallback สุดท้ายจริง ๆ กัน cell ว่าง
  return toCleanString_(lastCandidate || initialCandidate || originalCaption || "");
}

function buildRepairExitResult_(args) {
  args = args || {};

  const manualReviewEnabled = Boolean(args.manualReviewEnabled);
  const analysis = args.analysis || null;

  const originalCaption = args.originalCaption || "";
  const initialCandidate = args.initialCandidate || "";
  const lastCandidate = args.lastCandidate || "";

  const finalCaption = manualReviewEnabled
    ? buildNeedsManualReviewMessage_(analysis, {
        originalCaption: originalCaption,
        lastCandidate: lastCandidate
      })
    : pickLatestCaptionWithoutManualReview_(
        lastCandidate,
        initialCandidate,
        originalCaption
      );

  return {
    pass: false,
    finalCaption: finalCaption,
    lastCandidate: lastCandidate,
    roundsUsed: args.roundsUsed || 0,
    note: args.note || "Repair did not pass verification, but manual review output is disabled."
  };
}

function ensureRevisedCaptionPass_(args) {
  const url = args.url;
  const rawPrompt = args.rawPrompt;
  const rulesBlock = args.rulesBlock;
  const quickReferenceBlock = args.quickReferenceBlock || "{}";
  const originalCaption = args.originalCaption || "";
  const systemRow = args.systemRow;
  const maxGeminiAttempts = args.maxGeminiAttempts || 3;
  const geminiTemperature = args.geminiTemperature || 1.0;
  const geminiSeed = 42;
  const maxRepairRounds = args.maxRepairRounds || 3;
  const manualReviewEnabled = REPAIR_MANUAL_REVIEW_ENABLED;

  Logger.log(`System row ${systemRow}: repair manual review enabled = ${manualReviewEnabled}`);

  const initialCandidate = toCleanString_(args.initialRevisedCaption);
  let candidate = initialCandidate;
  let lastVerifyAnalysis = null;

  const failedRevisedCandidates = [];

  // สำคัญ: ถ้าไม่มี candidate ห้ามยิง NEEDS MANUAL REVIEW ตอนปิด manual review
  if (!candidate || isNeedsManualReviewText_(candidate)) {
    return buildRepairExitResult_({
      manualReviewEnabled: manualReviewEnabled,
      analysis: lastVerifyAnalysis,
      originalCaption: originalCaption,
      initialCandidate: initialCandidate,
      lastCandidate: candidate || originalCaption,
      roundsUsed: 0,
      note: "Initial revised caption was empty or manual-review-like."
    });
  }

  for (let round = 1; round <= maxRepairRounds; round++) {
    Logger.log(`System row ${systemRow}: verifying revised caption round ${round}/${maxRepairRounds}`);

    const verifyRun = runCaptionOnlyCheck_({
      url,
      rawPrompt,
      rulesBlock,
      quickReferenceBlock,
      caption: candidate,
      systemRow,
      maxGeminiAttempts,
      geminiTemperature,
      geminiSeed
    });

    // สำคัญ: verify API พัง ก็ return candidate ล่าสุด ไม่ใช่ manual review
    if (!verifyRun.ok) {
      return buildRepairExitResult_({
        manualReviewEnabled: manualReviewEnabled,
        analysis: lastVerifyAnalysis,
        originalCaption: originalCaption,
        initialCandidate: initialCandidate,
        lastCandidate: candidate,
        roundsUsed: round,
        note: `Verification failed: ${verifyRun.title || "UNKNOWN ERROR"}`
      });
    }

    lastVerifyAnalysis = verifyRun.analysis;

    if (isPassOrZeroFailAnalysis_(lastVerifyAnalysis)) {
      return {
        pass: true,
        finalCaption: candidate,
        lastCandidate: candidate,
        roundsUsed: round,
        note: "Revised caption passed re-check."
      };
    }

    Logger.log(`System row ${systemRow}: revised caption still failed on round ${round}`);

    const latestFailIssues = sortFailIssues_(normalizeIssuesFromAnalysis_(lastVerifyAnalysis));

    failedRevisedCandidates.push({
      round: round,
      caption: candidate,
      fail_issues: latestFailIssues.map(function(issue) {
        return {
          flagged_text: issue.flagged_text,
          issue_title: issue.issue_title,
          issue_detail: issue.issue_detail,
          fix_note: issue.fix_note,
          rule_id: issue.rule_id,
          basis_type: issue.basis_type
        };
      })
    });

    const repairRun = repairFailedRevisedCaption_({
      url,
      rawPrompt,
      rulesBlock,
      quickReferenceBlock,
      originalCaption,
      failedRevisedCandidates,
      verifyAnalysis: lastVerifyAnalysis,
      systemRow,
      maxGeminiAttempts,
      geminiTemperature,
      geminiSeed
    });

    // สำคัญ: repair fail ก็ return candidate ล่าสุด ไม่ใช่ NEEDS MANUAL REVIEW
    if (!repairRun.ok || !repairRun.repairedCaption) {
      return buildRepairExitResult_({
        manualReviewEnabled: manualReviewEnabled,
        analysis: lastVerifyAnalysis,
        originalCaption: originalCaption,
        initialCandidate: initialCandidate,
        lastCandidate: candidate,
        roundsUsed: round,
        note: repairRun.title || "Repair failed."
      });
    }

    candidate = toCleanString_(repairRun.repairedCaption);

    // กัน model ส่งคำว่า manual review กลับมาเอง
    if (isNeedsManualReviewText_(candidate)) {
      return buildRepairExitResult_({
        manualReviewEnabled: manualReviewEnabled,
        analysis: lastVerifyAnalysis,
        originalCaption: originalCaption,
        initialCandidate: initialCandidate,
        lastCandidate: initialCandidate || originalCaption,
        roundsUsed: round,
        note: "Repair returned manual-review-like text."
      });
    }

    // สำคัญที่สุด:
    // ถ้าถึงรอบสุดท้ายแล้ว manual review ปิดอยู่
    // ให้ return candidate ล่าสุดทันที ถึงยังไม่ได้ double check pass ก็ตาม
    if (round === maxRepairRounds && !manualReviewEnabled) {
      Logger.log(`System row ${systemRow}: manual review disabled; returning latest repaired caption even without pass confirmation`);

      return {
        pass: false,
        finalCaption: candidate,
        lastCandidate: candidate,
        roundsUsed: round,
        note: "Manual review disabled; using latest repaired caption without final pass confirmation."
      };
    }

    // ถ้าเปิด manual review อยู่ ค่อยทำ final verification แบบเดิม
    if (round === maxRepairRounds && manualReviewEnabled) {
      Logger.log(`System row ${systemRow}: final verification after last repair`);

      const finalVerifyRun = runCaptionOnlyCheck_({
        url,
        rawPrompt,
        rulesBlock,
        quickReferenceBlock,
        caption: candidate,
        systemRow,
        maxGeminiAttempts,
        geminiTemperature,
        geminiSeed
      });

      if (finalVerifyRun.ok) {
        lastVerifyAnalysis = finalVerifyRun.analysis;

        if (isPassOrZeroFailAnalysis_(lastVerifyAnalysis)) {
          return {
            pass: true,
            finalCaption: candidate,
            lastCandidate: candidate,
            roundsUsed: round,
            note: "Revised caption passed final re-check after last repair."
          };
        }
      }

      Logger.log(`System row ${systemRow}: final repaired caption did not pass verification; returning manual review`);
    }
  }

  // fallback สุดท้าย: ถ้าปิด manual review ต้องไม่คืน NEEDS MANUAL REVIEW
  return buildRepairExitResult_({
    manualReviewEnabled: manualReviewEnabled,
    analysis: lastVerifyAnalysis,
    originalCaption: originalCaption,
    initialCandidate: initialCandidate,
    lastCandidate: candidate,
    roundsUsed: maxRepairRounds,
    note: "Max repair rounds reached."
  });
}

function buildNeedsManualReviewMessage_(analysis, options) {
  options = options || {};

  const contextLabel = inferManualReviewContextLabel_(analysis, {
    originalCaption: options.originalCaption || "",
    lastCandidate: options.lastCandidate || ""
  });

  return `NEEDS MANUAL REVIEW: ไม่สามารถปรับปรุงข้อความได้เนื่องจากบริบทเป็นในลักษณะ "${contextLabel}" กรุณาดูคำแนะนำเพิ่มเติมใน rationale`;
}

function inferManualReviewContextLabel_(analysis, options) {
  options = options || {};

  const issues = normalizeIssuesFromAnalysis_(analysis);
  const parts = [];

  parts.push(options.originalCaption || "");
  parts.push(options.lastCandidate || "");

  issues.forEach(function(issue) {
    parts.push(issue.flagged_text || "");
    parts.push(issue.category || "");
    parts.push(issue.subcategory || "");
    parts.push(issue.policy_family || "");
    parts.push(issue.issue_title || "");
    parts.push(issue.issue_detail || "");
    parts.push(issue.fix_note || "");
    parts.push(issue.display_reference || "");
  });

  const text = parts
    .map(function(x) { return String(x || "").toLowerCase(); })
    .join("\n");

  if (
    /การพนัน|พนัน|สล็อต|slot|casino|บาคาร่า|baccarat|เว็บแทงบอล|แทงบอล|sportsbook|betting|bet\b|ฝาก.?ถอน|เติมเงิน|พนันออนไลน์/.test(text)
  ) {
    return "การโปรโมตการพนันออนไลน์";
  }

  if (
    /scalping|trading|trade|trader|forex|xauusd|gold|crypto|stock|winrate|win\s*rate|profit|return|roi|yield|อันดับ\s*1|no\.?\s*1|#\s*1|กำไร|ผลตอบแทน|เทรด|การลงทุน|ลงทุน|คริปโต|บิทคอยน์/.test(text)
  ) {
    return "การกล่าวอ้างด้านการเงิน การลงทุน หรือผลลัพธ์การเทรด";
  }

  if (
    /สุขภาพ|อาหารเสริม|ยา|เภสัช|อย\.|รักษา|โรค|อาการ|หายขาด|คลินิก|แพทย์|หมอ|โบท็อกซ์|ฟิลเลอร์|สิว|ฝ้า|ผิว|ลดน้ำหนัก|ผอม|ดีท็อกซ์|เข็ม|ฉีด|health|medical|clinic|doctor|supplement|wellness|pharma|rx|treat|cure|disease|symptom|weight loss|skincare|cosmetic/.test(text)
  ) {
    return "การกล่าวอ้างด้านสุขภาพหรือสรรพคุณของผลิตภัณฑ์";
  }

  if (
    /สรรพคุณ/.test(text) &&
    /สุขภาพ|อาหารเสริม|ยา|เภสัช|อย\.|รักษา|โรค|อาการ|หายขาด|คลินิก|แพทย์|หมอ|health|medical|clinic|doctor|supplement|wellness|pharma|rx|treat|cure|disease|symptom/.test(text)
  ) {
    return "การกล่าวอ้างด้านสุขภาพหรือสรรพคุณของผลิตภัณฑ์";
  }

  if (
    /สินเชื่อ|เงินกู้|หนี้|อนุมัติไว|ไม่มีความเสี่ยง|risk-free|returns|loan|debt|alcohol|nicotine|บุหรี่|เหล้า|เบียร์|ไวน์|รายได้|รับสมัคร|สมัครงาน|salary|passive income/.test(text)
  ) {
    return "การชักชวนหรือส่งเสริมพฤติกรรมที่อาจมีความเสี่ยง";
  }

  return "การชักชวนหรือส่งเสริมพฤติกรรมที่อาจมีความเสี่ยง";
}

function runCaptionOnlyCheck_(args) {
  const rawPrompt = args.rawPrompt || "";
  const promptHasInlineMessage = promptContainsMessagePlaceholder_(rawPrompt);

  const promptText = buildPromptText_(rawPrompt, {
    rulesBlock: args.rulesBlock,
    quickReferenceBlock: args.quickReferenceBlock || "{}",
    message: args.caption
  });

  const parts = [{
    text: [
      promptText,
      "",
      buildTaskInstruction_("caption_only")
    ].join("\n")
  }];

  if (!promptHasInlineMessage) {
    parts.push({
      text: `[CAPTION]\n${args.caption || ""}`
    });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: args.geminiTemperature || 1.0,
      seed: 42,
      maxOutputTokens: 10000,
      responseMimeType: "application/json",
      responseSchema: buildFDAResponseSchema_("caption_only")
    }
  };

  const run = callGeminiWithRetry_(
    args.url,
    payload,
    args.systemRow,
    args.maxGeminiAttempts || 3
  );

  if (!run.ok) {
    return {
      ok: false,
      title: run.title,
      detail: run.detail
    };
  }

  const analysis = extractAnalysisObject_(run.result || {}, "caption_analysis");

  return {
    ok: true,
    analysis,
    raw: run.raw
  };
}

function repairFailedRevisedCaption_(args) {
  const verifyIssues = normalizeIssuesFromAnalysis_(args.verifyAnalysis);
  const failIssues = sortFailIssues_(verifyIssues);

  const repairInstruction = [
    "You are AdShield Lite / AdShield Unified Compliance Checker.",
    "You are repairing a revised ad caption that still failed compliance re-check.",
    "",
    "CRITICAL FORMAT RULE:",
    "- Use ORIGINAL CAPTION as the formatting and layout anchor.",
    "- Repair line-by-line using ORIGINAL CAPTION.",
    "- Keep unchanged if safe, neutralize only the risky phrase if partly risky, or remove the line only if the whole line is unsafe.",
    "- Preserve line breaks, emoji placement, list style, price lines, product registration line, warning line, and CTA line as much as possible.",
    "- Do NOT rewrite the whole caption if only some phrases are risky.",
    "- IMPORTANT: Using the original caption as a layout anchor does NOT mean preserving risky wording. If the risky wording is short and easy to remove, remove it directly.",
    "",
    "SAFETY REWRITE RULE:",
    "- Remove or neutralize every fail issue found in the failed candidate.",
    "- Remove disease cure/treatment/prevention/reversal claims.",
    "- Remove cancer-risk fear claims.",
    "- Remove guarantees, absolutes, and time-bound outcomes.",
    "- Do not introduce new benefit, medical, beauty, investment, guarantee, approval, or performance claims.",
    "- Use neutral product-description language if unsure.",
    "",
    "FINANCE / TRADING / PERFORMANCE CLAIM REPAIR RULE:",
    "- If the failed issue involves trading, investment, scalping, forex, crypto, stocks, gold, XAUUSD, winrate, profit, return, or performance claims, remove or neutralize the performance claim.",
    "- Remove unsupported ranking or superlative claims such as 'อันดับ 1', 'No.1', '#1', 'ดีที่สุด', 'top', 'best', 'highest winrate', or 'winrate อันดับ 1'.",
    "- Replace unsupported ranking claims with neutral experience wording, e.g. 'ผู้สอนที่มีประสบการณ์ด้านการเทรด' or 'โค้ชที่มีประสบการณ์'.",
    "- Do not claim profit, winrate, success rate, guaranteed outcome, ranking, or being the best unless evidence is explicitly provided and the source rules allow it.",
    "- For short captions, prefer a minimal safe rewrite instead of manual review.",
    "",
    "OUTPUT RULE:",
    "- Return JSON using caption_analysis only.",
    "- caption_analysis.revised_message and caption_analysis.revised_caption must contain the best repaired caption.",
    "- NEVER output 'NEEDS MANUAL REVIEW'.",
    "- NEVER leave revised_message or revised_caption empty.",
    "- If the repaired caption may still fail, still return the safest repaired caption you can produce.",
    "- Do not ask for manual review.",
    "",
    "ORIGINAL CAPTION - USE THIS AS LAYOUT TEMPLATE:",
    args.originalCaption || "",
    "",
    "FAILED REVISED CANDIDATES - DO NOT COPY THEIR FAILED WORDING OR BROKEN FORMAT:",
    JSON.stringify(args.failedRevisedCandidates || [], null, 2),
    "",
    "FAIL ISSUES FOUND ON RECHECK:",
    JSON.stringify(failIssues, null, 2),
    "",
    "RULES_BLOCK:",
    args.rulesBlock || "",
    "",
    "QUICK_REFERENCE_BLOCK:",
    args.quickReferenceBlock || "{}",
    "",
    buildTaskInstruction_("caption_only")
  ].join("\n");

  const parts = [{
    text: repairInstruction
  }];

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: args.geminiTemperature || 1.0,
      seed: 42,
      maxOutputTokens: 10000,
      responseMimeType: "application/json",
      responseSchema: buildFDAResponseSchema_("caption_only")
    }
  };

  const run = callGeminiWithRetry_(
    args.url,
    payload,
    args.systemRow,
    args.maxGeminiAttempts || 3
  );

  if (!run.ok) {
    return {
      ok: false,
      title: run.title,
      detail: run.detail,
      repairedCaption: ""
    };
  }

  const analysis = extractAnalysisObject_(run.result || {}, "caption_analysis");
  const repairedCaption = toCleanString_(analysis.revised_caption || analysis.revised_message);

  return {
    ok: true,
    analysis,
    repairedCaption
  };
}

/* =====================================================================
 * RESPONSE SCHEMA
 * ===================================================================== */

function buildFDAResponseSchema_(mode) {
  mode = mode || "both";

  const analysisSchema = buildPassFailAnalysisSchema_();
  const imageAnalysisSchema = buildPassFailImageAnalysisSchema_();

  if (mode === "caption_only") {
    return {
      type: "object",
      properties: {
        caption_analysis: analysisSchema
      },
      required: ["caption_analysis"]
    };
  }

  if (mode === "image_only") {
    return {
      type: "object",
      properties: {
        image_analysis: imageAnalysisSchema
      },
      required: ["image_analysis"]
    };
  }

  return {
    type: "object",
    properties: {
      caption_analysis: analysisSchema,
      image_analysis: imageAnalysisSchema
    },
    required: ["caption_analysis", "image_analysis"]
  };
}

function buildPassFailAnalysisSchema_() {
  return {
    type: "object",
    properties: {
      original_message: { type: "string" },
      revised_message: { type: "string" },
      revised_caption: { type: "string" },
      overall_result: {
        type: "string",
        enum: ["pass", "fail"]
      },
      summary: buildPassFailSummarySchema_(),
      quick_reference: buildQuickReferenceSchema_(),
      spell_check: buildSpellCheckSchema_(),
      issues: {
        type: "array",
        items: buildFailIssueSchema_()
      }
    },
    required: [
      "original_message",
      "revised_message",
      "revised_caption",
      "overall_result",
      "summary",
      "quick_reference",
      "spell_check",
      "issues"
    ]
  };
}

function buildPassFailImageAnalysisSchema_() {
  const base = buildPassFailAnalysisSchema_();

  base.properties.extracted_images = {
    type: "array",
    items: buildPerImageTextSchema_()
  };

  base.properties.revised_images = {
    type: "array",
    items: buildPerImageTextSchema_()
  };

  base.properties.extracted_text = buildTextBlocksSchema_();
  base.properties.revised_image_text = buildTextBlocksSchema_();

  base.required = [
    "original_message",
    "revised_message",
    "revised_caption",
    "overall_result",
    "summary",
    "quick_reference",
    "spell_check",
    "issues",
    "extracted_images",
    "revised_images"
  ];

  return base;
}

function buildPassFailSummarySchema_() {
  return {
    type: "object",
    properties: {
      overall_verdict: {
        type: "string",
        enum: ["pass", "fail"]
      },
      display_title: { type: "string" },
      display_subtitle: { type: "string" },
      issue_count: { type: "integer" },
      fail_count: { type: "integer" },
      executive_summary: { type: "string" }
    },
    required: [
      "overall_verdict",
      "display_title",
      "display_subtitle",
      "issue_count",
      "fail_count",
      "executive_summary"
    ]
  };
}

function buildQuickReferenceSchema_() {
  return {
    type: "object",
    properties: {
      business_context: { type: "string" },
      primary_policy_family: { type: "string" },
      source_priority_used: {
        type: "array",
        items: { type: "string" }
      },
      approval_or_notice_checklist: {
        type: "array",
        items: { type: "string" }
      },
      required_disclosures_or_warnings: {
        type: "array",
        items: { type: "string" }
      },
      platform_special_checks: {
        type: "array",
        items: { type: "string" }
      },
      quick_do_not_do: {
        type: "array",
        items: { type: "string" }
      },
      quick_best_practice: {
        type: "array",
        items: { type: "string" }
      },
      reviewer_notes: {
        type: "array",
        items: { type: "string" }
      },
      fallback_major_laws_or_policies: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "business_context",
      "primary_policy_family",
      "source_priority_used",
      "approval_or_notice_checklist",
      "required_disclosures_or_warnings",
      "platform_special_checks",
      "quick_do_not_do",
      "quick_best_practice",
      "reviewer_notes",
      "fallback_major_laws_or_policies"
    ]
  };
}

function buildSpellCheckSchema_() {
  return {
    type: "object",
    properties: {
      has_spelling_issues: { type: "boolean" },
      corrected_message: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            order_index: { type: "integer" },
            original_text: { type: "string" },
            suggested_text: { type: "string" },
            error_type: {
              type: "string",
              enum: [
                "spelling",
                "typo",
                "spacing",
                "grammar",
                "punctuation",
                "capitalization",
                "duplicate_word",
                "ocr_artifact"
              ]
            },
            confidence: {
              type: "string",
              enum: ["high", "medium"]
            },
            explanation: { type: "string" }
          },
          required: [
            "order_index",
            "original_text",
            "suggested_text",
            "error_type",
            "confidence",
            "explanation"
          ]
        }
      },
      notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "has_spelling_issues",
      "corrected_message",
      "items",
      "notes"
    ]
  };
}

function buildFailIssueSchema_() {
  return {
    type: "object",
    properties: {
      order_index: { type: "integer" },
      flagged_text: { type: "string" },
      verdict: {
        type: "string",
        enum: ["fail"]
      },
      basis_type: {
        type: "string",
        enum: ["explicit_rule", "strong_rule_support"]
      },
      confidence: {
        type: "string",
        enum: ["high", "medium"]
      },
      source_type: { type: "string" },
      rule_id: { type: "string" },

      priority: { type: "integer" },
      rules_block_priority: { type: "integer" },

      policy_family: { type: "string" },
      law_name: { type: "string" },
      gazette_or_announcement: { type: "string" },
      reference_locator: { type: "string" },
      reference_section: { type: "string" },
      display_reference: { type: "string" },
      category: { type: "string" },
      subcategory: { type: "string" },
      issue_title: { type: "string" },
      issue_detail: { type: "string" },
      fix_note: { type: "string" },
      additional_references: {
        type: "array",
        items: {
          type: "object",
          properties: {
            law_name: { type: "string" },
            gazette_or_announcement: { type: "string" },
            reference_locator: { type: "string" },
            display_reference: { type: "string" }
          },
          required: [
            "law_name",
            "gazette_or_announcement",
            "reference_locator",
            "display_reference"
          ]
        }
      }
    },
    required: [
      "order_index",
      "flagged_text",
      "verdict",
      "basis_type",
      "confidence",
      "source_type",
      "rule_id",

      "priority",
      "rules_block_priority",

      "policy_family",
      "law_name",
      "gazette_or_announcement",
      "reference_locator",
      "reference_section",
      "display_reference",
      "category",
      "subcategory",
      "issue_title",
      "issue_detail",
      "fix_note",
      "additional_references"
    ]
  };
}

function buildPerImageTextSchema_() {
  return {
    type: "object",
    properties: {
      image_number: { type: "integer" },
      headlines: {
        type: "array",
        items: { type: "string" }
      },
      subheadlines: {
        type: "array",
        items: { type: "string" }
      },
      descriptions: {
        type: "array",
        items: { type: "string" }
      },
      ctas: {
        type: "array",
        items: { type: "string" }
      },
      other_text: {
        type: "array",
        items: { type: "string" }
      },
      full_text: {
        type: "string"
      }
    },
    required: [
      "image_number",
      "headlines",
      "subheadlines",
      "descriptions",
      "ctas",
      "other_text",
      "full_text"
    ]
  };
}

function buildTextBlocksSchema_() {
  return {
    type: "object",
    properties: {
      headlines: {
        type: "array",
        items: { type: "string" }
      },
      subheadlines: {
        type: "array",
        items: { type: "string" }
      },
      descriptions: {
        type: "array",
        items: { type: "string" }
      },
      ctas: {
        type: "array",
        items: { type: "string" }
      },
      other_text: {
        type: "array",
        items: { type: "string" }
      },
      full_text: {
        type: "string"
      }
    },
    required: [
      "headlines",
      "subheadlines",
      "descriptions",
      "ctas",
      "other_text",
      "full_text"
    ]
  };
}

function extractAnalysisObject_(result, key) {
  const r = result || {};

  if (r[key] && typeof r[key] === "object") {
    return r[key];
  }

  if (
    r.original_message !== undefined ||
    r.revised_message !== undefined ||
    r.overall_result !== undefined ||
    r.summary !== undefined ||
    Array.isArray(r.issues)
  ) {
    return r;
  }

  return {};
}

/* =====================================================================
 * GEMINI GENERATION CALL
 * ===================================================================== */

function callGeminiWithRetry_(url, payload, systemRow, maxAttempts) {
  const attempts = Math.max(1, Number(maxAttempts) || 1);

  let lastTitle = "UNKNOWN ERROR";
  let lastDetail = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    Logger.log(`System row ${systemRow}: sending request to Gemini... attempt ${attempt}/${attempts}`);

    try {
      const options = {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();
      const raw = response.getContentText();

      Logger.log(`System row ${systemRow}: responseCode=${responseCode} (attempt ${attempt}/${attempts})`);

      let json;
      try {
        json = JSON.parse(raw);
      } catch (jsonErr) {
        lastTitle = "RAW RESPONSE JSON PARSE ERROR";
        lastDetail = raw;

        Logger.log(`System row ${systemRow}: ${lastTitle} on attempt ${attempt}/${attempts}`);

        if (attempt < attempts) {
          sleepBeforeGeminiRetry_(attempt, systemRow, lastTitle);
          continue;
        }

        return {
          ok: false,
          title: lastTitle,
          detail: lastDetail,
          responseCode: responseCode,
          attemptUsed: attempt
        };
      }

      if (responseCode !== 200 || !json.candidates || !json.candidates[0]) {
        lastTitle = `API ERROR (${responseCode})`;
        lastDetail = raw;

        Logger.log(`System row ${systemRow}: ${lastTitle} on attempt ${attempt}/${attempts}`);

        const retryable = shouldRetryGeminiStatusCode_(responseCode) || responseCode === 200;

        if (retryable && attempt < attempts) {
          sleepBeforeGeminiRetry_(attempt, systemRow, lastTitle);
          continue;
        }

        return {
          ok: false,
          title: lastTitle,
          detail: lastDetail,
          responseCode: responseCode,
          attemptUsed: attempt
        };
      }

      const candidateParts = ((((json.candidates || [])[0] || {}).content || {}).parts || []);
      const fullText = candidateParts
        .map(part => part && part.text ? part.text : "")
        .join("\n")
        .trim();

      if (!fullText) {
        lastTitle = "EMPTY MODEL OUTPUT";
        lastDetail = raw;

        Logger.log(`System row ${systemRow}: ${lastTitle} on attempt ${attempt}/${attempts}`);

        if (attempt < attempts) {
          sleepBeforeGeminiRetry_(attempt, systemRow, lastTitle);
          continue;
        }

        return {
          ok: false,
          title: lastTitle,
          detail: lastDetail,
          responseCode: responseCode,
          attemptUsed: attempt
        };
      }

      Logger.log(`System row ${systemRow}: candidate text received on attempt ${attempt}/${attempts}`);

      let result;
      try {
        result = parseJsonLenient_(fullText);
      } catch (parseErr) {
        lastTitle = "JSON PARSE ERROR";
        lastDetail = fullText;

        Logger.log(`System row ${systemRow}: ${lastTitle} on attempt ${attempt}/${attempts}`);
        Logger.log(`System row ${systemRow}: parseErr=${parseErr.message}`);

        if (attempt < attempts) {
          sleepBeforeGeminiRetry_(attempt, systemRow, lastTitle);
          continue;
        }

        return {
          ok: false,
          title: lastTitle,
          detail: lastDetail,
          responseCode: responseCode,
          attemptUsed: attempt
        };
      }

      return {
        ok: true,
        result: result,
        raw: raw,
        responseCode: responseCode,
        attemptUsed: attempt
      };

    } catch (err) {
      lastTitle = "REQUEST ERROR";
      lastDetail = err && err.message ? err.message : String(err);

      Logger.log(`System row ${systemRow}: ${lastTitle} on attempt ${attempt}/${attempts}: ${lastDetail}`);

      if (attempt < attempts) {
        sleepBeforeGeminiRetry_(attempt, systemRow, lastTitle);
        continue;
      }

      return {
        ok: false,
        title: lastTitle,
        detail: lastDetail,
        responseCode: null,
        attemptUsed: attempt
      };
    }
  }

  return {
    ok: false,
    title: lastTitle,
    detail: lastDetail,
    responseCode: null,
    attemptUsed: attempts
  };
}

function shouldRetryGeminiStatusCode_(code) {
  const c = Number(code) || 0;

  return (
    c === 408 ||
    c === 409 ||
    c === 425 ||
    c === 429 ||
    c === 500 ||
    c === 502 ||
    c === 503 ||
    c === 504
  );
}

function sleepBeforeGeminiRetry_(attempt, systemRow, reason) {
  const ms = getGeminiRetryDelayMs_(attempt);
  Logger.log(`System row ${systemRow}: retrying because ${reason} | sleep ${ms} ms`);
  Utilities.sleep(ms);
}

function getGeminiRetryDelayMs_(attempt) {
  const delays = [800, 1500, 2500, 4000, 6000];
  const idx = Math.min(Math.max(attempt - 1, 0), delays.length - 1);
  return delays[idx];
}

function parseJsonLenient_(text) {
  let s = String(text || "").trim();

  if (!s) {
    throw new Error("Empty text");
  }

  s = s.replace(/^\uFEFF/, "").trim();

  s = s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(s);
  } catch (e1) {
    const firstBrace = s.indexOf("{");
    const lastBrace = s.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const sliced = s.slice(firstBrace, lastBrace + 1);
      return JSON.parse(sliced);
    }

    throw e1;
  }
}

/* =====================================================================
 * RATIONALE / OUTPUT FORMAT
 * ===================================================================== */
function getBestRevisedMessageFromAnalysis_(analysis) {
  const a = analysis || {};
  const spellCheck = normalizeSpellCheckFromAnalysis_(analysis);

  const revised = toCleanString_(a.revised_caption || a.revised_message);
  if (revised) return revised;

  if (spellCheck.has_spelling_issues && spellCheck.corrected_message) {
    return spellCheck.corrected_message;
  }

  return "";
}

function normalizeSpellIssuesAsFailIssues_(analysis, startIndex) {
  const spellCheck = normalizeSpellCheckFromAnalysis_(analysis);
  const items = Array.isArray(spellCheck.items) ? spellCheck.items : [];

  return items.map(function(item, index) {
    const originalText = toCleanString_(item.original_text);
    const suggestedText = toCleanString_(item.suggested_text);
    const explanation = toCleanString_(item.explanation);
    const errorType = toCleanString_(item.error_type) || "spelling";
    const confidence = toCleanString_(item.confidence) || "medium";

    return {
      order_index: Number(startIndex) + index,
      flagged_text: originalText,
      verdict: "fail",
      basis_type: "spell_check",
      confidence: confidence,
      source_type: "spell_check",
      rule_id: "spell_check",
      policy_family: "spell_check",
      category: errorType,
      subcategory: "spell_check",
      issue_title: originalText
        ? `สะกด \`${originalText}\` ผิด`
        : "พบคำสะกดผิด",
      issue_detail: explanation || (
        suggestedText
          ? `ควรแก้เป็น \`${suggestedText}\``
          : "พบคำหรือข้อความที่ควรตรวจแก้"
      ),
      fix_note: suggestedText ? `แก้เป็น \`${suggestedText}\`` : "",
      display_reference: "Spell check",
      is_spelling_issue: true,
      original_text: originalText,
      suggested_text: suggestedText,
      error_type: errorType,
      explanation: explanation
    };
  });
}

function getCombinedFailIssues_(analysis) {
  const policyIssues = sortFailIssues_(normalizeIssuesFromAnalysis_(analysis));
  const spellIssues = normalizeSpellIssuesAsFailIssues_(
    analysis,
    policyIssues.length + 1
  );

  return policyIssues.concat(spellIssues);
}

function buildCombinedExecutiveSummary_(analysis, policyIssues, spellIssues) {
  const policyList = Array.isArray(policyIssues) ? policyIssues : [];
  const spellList = Array.isArray(spellIssues) ? spellIssues : [];
  const policyCount = policyList.length;
  const spellCount = spellList.length;

  if (policyCount === 0 && spellCount === 0) {
    return "ไม่พบประเด็นที่ไม่ผ่าน";
  }

  const parts = [];

  policyList.forEach(function(issue) {
    const label = toCleanString_(issue.issue_title || issue.flagged_text);
    if (label) parts.push(label);
  });

  if (spellCount > 0) {
    parts.push(`พบคำสะกดผิด ${spellCount} จุด`);
  }

  if (parts.length === 0) {
    return "ข้อความมีประเด็นที่ไม่ผ่านตามกฎที่เกี่ยวข้อง";
  }

  return parts.join(" และ ");
}

function formatCaptionRationale_(analysis) {
  return formatPolicyRationaleBlock_(analysis, {
    titlePrefix: "",
    fetchErrors: []
  });
}

function formatImageRationale_(analysis, fetchErrors) {
  return formatPolicyRationaleBlock_(analysis, {
    titlePrefix: "",
    fetchErrors: fetchErrors || []
  });
}

function buildPassRevisedText_() {
  return "ผลตรวจ: pass";
}

function buildPassRationaleText_(analysis) {
  const combinedIssues = getCombinedFailIssues_(analysis);
  const overall = computeOverallPassFailFromIssues_(
    combinedIssues,
    getOverallVerdictFromAnalysis_(analysis)
  );

  if (overall === "fail" || combinedIssues.length > 0) {
    return formatPolicyRationaleBlock_(analysis, {
      titlePrefix: "",
      fetchErrors: []
    });
  }

  const lines = [
    "ผลตรวจ: pass",
    "พบ 0 ประเด็นที่ไม่ผ่าน",
    "",
    "สรุป: ไม่พบประเด็นที่ไม่ผ่าน",
    "",
    "ประเด็นที่ไม่ผ่าน:",
    "- ไม่พบประเด็นที่ไม่ผ่าน"
  ];

  return lines.join("\n");
}

function buildPassRevisedTextForSheet_(analysis) {
  const spellCheck = normalizeSpellCheckFromAnalysis_(analysis);

  if (
    spellCheck.has_spelling_issues &&
    spellCheck.corrected_message
  ) {
    return spellCheck.corrected_message;
  }

  return buildPassRevisedText_();
}

function isPassOrZeroFailAnalysis_(analysis) {
  const combinedIssues = getCombinedFailIssues_(analysis);
  const overall = computeOverallPassFailFromIssues_(
    combinedIssues,
    getOverallVerdictFromAnalysis_(analysis)
  );

  return overall === "pass" && combinedIssues.length === 0;
}

function formatPolicyRationaleBlock_(analysis, options) {
  options = options || {};
  const fetchErrors = Array.isArray(options.fetchErrors) ? options.fetchErrors : [];

  const policyIssues = sortFailIssues_(normalizeIssuesFromAnalysis_(analysis));
  const spellIssues = normalizeSpellIssuesAsFailIssues_(
    analysis,
    policyIssues.length + 1
  );
  const combinedIssues = policyIssues.concat(spellIssues);

  const overall = computeOverallPassFailFromIssues_(
    combinedIssues,
    getOverallVerdictFromAnalysis_(analysis)
  );

  const summary = buildCombinedExecutiveSummary_(
    analysis,
    policyIssues,
    spellIssues
  );

  const quickReference = (analysis && analysis.quick_reference) || {};
  const reviewerNotes = Array.isArray(quickReference.reviewer_notes)
    ? quickReference.reviewer_notes.map(toCleanString_).filter(Boolean)
    : [];

  const lines = [];
  lines.push(`ผลตรวจ: ${overall}`);
  lines.push(`พบ ${combinedIssues.length} ประเด็นที่ไม่ผ่าน`);
  lines.push("");
  lines.push(`สรุป: ${summary || "-"}`);
  lines.push("");

  if (combinedIssues.length) {
    lines.push("ประเด็นที่ไม่ผ่าน:");

    for (let i = 0; i < combinedIssues.length; i++) {
      const issue = combinedIssues[i];

      if (issue.is_spelling_issue) {
        const originalText = toCleanString_(issue.original_text || issue.flagged_text) || "-";
        const suggestedText = toCleanString_(issue.suggested_text);
        const explanation = toCleanString_(issue.explanation || issue.issue_detail) || "-";

        lines.push(`${i + 1}) [fail] สะกด \`${originalText}\` ผิด`);

        if (suggestedText) {
          lines.push(`- แนะนำ: แก้เป็น \`${suggestedText}\``);
        }

        lines.push(`- เหตุผล: ${explanation}`);
      } else {
        const verdict = normalizeIssueVerdict_(issue.verdict);
        const title = toCleanString_(issue.issue_title || issue.title) || "ไม่ระบุหัวข้อ";
        const flaggedText = toCleanString_(issue.flagged_text) || "-";
        const detail = toCleanString_(issue.issue_detail || issue.detail) || "-";
        const recommendation = toCleanString_(issue.fix_note || issue.recommendation) || "-";
        const reference = toCleanString_(issue.display_reference || issue.reference) || "-";

        lines.push(`${i + 1}) [${verdict}] ${title}`);
        lines.push(`- ข้อความที่พบ: ${flaggedText}`);
        lines.push(`- รายละเอียด: ${detail}`);
        lines.push(`- แนะนำ: ${recommendation}`);
        lines.push(`- อ้างอิง: ${reference}`);
      }

      if (i < combinedIssues.length - 1) {
        lines.push("");
      }
    }
  } else {
    lines.push("ประเด็นที่ไม่ผ่าน:");
    lines.push("- ไม่พบประเด็นที่ไม่ผ่าน");
  }

  if (reviewerNotes.length) {
    lines.push("");
    lines.push("Reviewer notes:");
    for (let r = 0; r < reviewerNotes.length; r++) {
      lines.push(`- ${reviewerNotes[r]}`);
    }
  }

  if (fetchErrors.length) {
    lines.push("");
    lines.push("หมายเหตุการดึงรูป:");
    for (let j = 0; j < fetchErrors.length; j++) {
      lines.push(`- ${fetchErrors[j]}`);
    }
  }

  return lines.join("\n").trim();
}

function getOverallVerdictFromAnalysis_(analysis) {
  const a = analysis || {};

  if (a.summary && typeof a.summary === "object" && a.summary.overall_verdict) {
    return a.summary.overall_verdict;
  }

  return a.overall_result || a.verdict || "";
}

function getExecutiveSummaryFromAnalysis_(analysis) {
  const a = analysis || {};

  if (a.summary && typeof a.summary === "object") {
    return toCleanString_(a.summary.executive_summary || a.summary.display_subtitle || a.summary.display_title);
  }

  if (typeof a.summary === "string") {
    return toCleanString_(a.summary);
  }

  return toCleanString_(a.reason || a.executive_summary || "-");
}

function normalizeIssuesFromAnalysis_(analysis) {
  const a = analysis || {};
  const directIssues = Array.isArray(a.issues) ? a.issues : [];

  if (directIssues.length) {
    return directIssues.map(normalizeSingleIssue_);
  }

  const out = [];
  const redMatches = Array.isArray(a.red_matches) ? a.red_matches : [];
  const yellowMatches = Array.isArray(a.yellow_matches) ? a.yellow_matches : [];
  const fixNotes = Array.isArray(a.fix_notes) ? a.fix_notes : [];
  const reason = toCleanString_(a.reason);

  for (let i = 0; i < redMatches.length; i++) {
    out.push({
      order_index: out.length + 1,
      flagged_text: toCleanString_(redMatches[i]),
      verdict: "fail",
      basis_type: "explicit_rule",
      confidence: "high",
      issue_title: toCleanString_(redMatches[i]) || "พบประเด็นที่ไม่ผ่าน",
      issue_detail: reason || "-",
      fix_note: fixNotes[i] || fixNotes[0] || "-",
      display_reference: "-"
    });
  }

  for (let j = 0; j < yellowMatches.length; j++) {
    out.push({
      order_index: out.length + 1,
      flagged_text: toCleanString_(yellowMatches[j]),
      verdict: "fail",
      basis_type: "strong_rule_support",
      confidence: "medium",
      issue_title: toCleanString_(yellowMatches[j]) || "พบประเด็นที่ไม่ผ่าน",
      issue_detail: reason || "-",
      fix_note: fixNotes[j] || fixNotes[0] || "-",
      display_reference: "-"
    });
  }

  return out.map(normalizeSingleIssue_);
}

function normalizeSingleIssue_(issue) {
  const x = issue || {};

  return {
    order_index: Number(x.order_index) || 9999,
    flagged_text: toCleanString_(x.flagged_text || x.text || x.match),
    verdict: normalizeIssueVerdict_(x.verdict || x.severity),
    basis_type: toCleanString_(x.basis_type),
    confidence: toCleanString_(x.confidence),
    source_type: toCleanString_(x.source_type),
    rule_id: toCleanString_(x.rule_id),

    priority: Number(x.priority) || 100,
    rules_block_priority: Number(x.rules_block_priority) || Number(x.priority) || 100,

    policy_family: toCleanString_(x.policy_family),
    law_name: toCleanString_(x.law_name),
    gazette_or_announcement: toCleanString_(x.gazette_or_announcement),
    reference_locator: toCleanString_(x.reference_locator),
    reference_section: toCleanString_(x.reference_section),
    display_reference: toCleanString_(x.display_reference || x.reference || x.ref_display),
    category: toCleanString_(x.category),
    subcategory: toCleanString_(x.subcategory),
    issue_title: toCleanString_(x.issue_title || x.title || x.issue || x.label || x.short_title),
    issue_detail: toCleanString_(x.issue_detail || x.detail || x.description || x.reason),
    fix_note: toCleanString_(x.fix_note || x.recommendation || x.suggestion || x.fix),
    additional_references: Array.isArray(x.additional_references) ? x.additional_references : []
  };
}

function normalizeIssueVerdict_(value) {
  const s = String(value || "").trim().toLowerCase();

  if (s === "fail") return "fail";
  if (s === "pass") return "pass";

  if (
    s === "severe" ||
    s === "warning" ||
    s === "high" ||
    s === "medium" ||
    s === "red" ||
    s === "yellow"
  ) {
    return "fail";
  }

  return "pass";
}

function sortFailIssues_(issues) {
  const list = Array.isArray(issues) ? issues.slice() : [];

  return list
    .filter(issue => normalizeIssueVerdict_(issue.verdict || issue.severity) === "fail")
    .filter(shouldKeepFailIssueAfterPriorityFilter_)
    .sort(function(a, b) {
      const ai = Number(a.order_index) || 9999;
      const bi = Number(b.order_index) || 9999;
      return ai - bi;
    });
}

function enrichIssuesWithRulePriority_(analysis, policyRows) {
  // No-op: the new policy_rules schema does not carry priority.
  // Background/context-only suppression is now driven by HARD_FILTER_RULE_IDS
  // in shouldKeepFailIssueAfterPriorityFilter_.
}

function shouldKeepFailIssueAfterPriorityFilter_(issue) {
  const x = issue || {};

  // Spell check issues are not policy_rules and must never be hard-filtered.
  if (x.is_spelling_issue || x.source_type === "spell_check" || x.rule_id === "spell_check") {
    return true;
  }

  // HARD FILTER:
  // rule_ids listed in HARD_FILTER_RULE_IDS are background/context only and must
  // not interrupt, count, or display as fail (same flow as the old priority==50).
  const ruleId = toCleanString_(x.rule_id);
  if (ruleId && HARD_FILTER_RULE_IDS.indexOf(ruleId) !== -1) {
    return false;
  }

  return true;
}

function computeOverallPassFailFromIssues_(issues, fallback) {
  const list = Array.isArray(issues) ? issues : [];

  // After hard filter, the remaining issue list is the source of truth.
  // If all model fail issues were priority 50 and got removed, this must pass.
  if (list.length > 0) return "fail";

  return "pass";
}

function formatRevisedImageTextCell_(imageAnalysis) {
  const a = imageAnalysis || {};

  const revisedImages = Array.isArray(a.revised_images) ? a.revised_images : [];
  if (revisedImages.length) {
    return formatPerImageTextBlocks_(revisedImages);
  }

  const revisedMessage = toCleanString_(a.revised_message);
  if (revisedMessage) {
    return revisedMessage;
  }

  const legacy = a.revised_image_text || {};
  return formatImageTextBreakdown_(legacy);
}

function appendLabeledLines_(lines, label, items) {
  const arr = Array.isArray(items)
    ? items.map(x => toCleanString_(x)).filter(Boolean)
    : [];

  arr.forEach(text => {
    lines.push(`- ${label} : ${text}`);
  });
}

function formatPerImageTextBlocks_(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return "";

  const blocks = [];

  for (let i = 0; i < list.length; i++) {
    const img = list[i] || {};
    const imageNo = Number(img.image_number) || (i + 1);
    const lines = [`[image รูปที่ ${imageNo}]`];

    appendLabeledLines_(lines, "Headline", img.headlines);
    appendLabeledLines_(lines, "Subheadline", img.subheadlines);
    appendLabeledLines_(lines, "Description", img.descriptions);
    appendLabeledLines_(lines, "CTA", img.ctas);
    appendLabeledLines_(lines, "Other text", img.other_text);

    const fullText = toCleanString_(img.full_text);

    if (lines.length === 1 && fullText) {
      lines.push(`- Full text (fallback) : ${fullText}`);
    }

    if (lines.length === 1 && !fullText) {
      lines.push(`- ไม่มีข้อความที่มองเห็นได้`);
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n").trim();
}

function formatImageTextBreakdown_(obj) {
  const t = obj || {};
  const headlines = Array.isArray(t.headlines) ? t.headlines.filter(Boolean) : [];
  const subheadlines = Array.isArray(t.subheadlines) ? t.subheadlines.filter(Boolean) : [];
  const descriptions = Array.isArray(t.descriptions) ? t.descriptions.filter(Boolean) : [];
  const ctas = Array.isArray(t.ctas) ? t.ctas.filter(Boolean) : [];
  const otherText = Array.isArray(t.other_text) ? t.other_text.filter(Boolean) : [];
  const fullText = toCleanString_(t.full_text);

  const blocks = [];

  if (headlines.length) {
    blocks.push(`HEADLINES:\n${headlines.map(x => `• ${x}`).join("\n")}`);
  }
  if (subheadlines.length) {
    blocks.push(`SUBHEADLINES:\n${subheadlines.map(x => `• ${x}`).join("\n")}`);
  }
  if (descriptions.length) {
    blocks.push(`DESCRIPTIONS:\n${descriptions.map(x => `• ${x}`).join("\n")}`);
  }
  if (ctas.length) {
    blocks.push(`CTAS:\n${ctas.map(x => `• ${x}`).join("\n")}`);
  }
  if (otherText.length) {
    blocks.push(`OTHER TEXT:\n${otherText.map(x => `• ${x}`).join("\n")}`);
  }
  if (fullText) {
    blocks.push(`FULL TEXT:\n${fullText}`);
  }

  return blocks.join("\n\n").trim();
}

/* =====================================================================
 * 7. IMAGE FETCH HELPERS
 * ===================================================================== */

function fetchImageBlobSafely_(imageUrl) {
  const url = toCleanString_(imageUrl);
  if (!url) {
    return {
      ok: false,
      sourceType: "external_url",
      errorKind: "unknown_image_fetch_failed",
      userMessage: "ไม่สามารถดึงรูปภาพจากลิงก์นี้ได้",
      technicalMessage: "empty image url"
    };
  }

  if (isGoogleDriveFolderUrl_(url)) {
    return {
      ok: false,
      sourceType: "google_drive",
      errorKind: "google_drive_invalid_image_link",
      userMessage: "ไม่สามารถดึงรูปภาพจากลิงก์ Google Drive ได้",
      technicalMessage:
        "ระบบเข้าถึง Google Drive ได้ แต่ไม่สามารถดึงรูปภาพจากลิงก์นี้ กรุณาตรวจสอบว่าเป็นลิงก์ไฟล์รูปภาพโดยตรง ไม่ใช่ลิงก์โฟลเดอร์ เอกสาร หรือไฟล์ที่ไม่ใช่รูปภาพ"
    };
  }

  const driveFileId = extractDriveFileId_(url);
  const sourceType = driveFileId ? "google_drive" : "external_url";

  try {
    let blob = null;

    if (driveFileId) {
      const driveResult = fetchDriveImageBlob_(driveFileId);
      if (!driveResult.ok) {
        return driveResult;
      }
      blob = driveResult.blob;
    } else {
      blob = fetchExternalImageBlob_(url);
    }

    const validated = validateImageBlob_(blob);
    if (!validated.ok) {
      if (sourceType === "google_drive") {
        return {
          ok: false,
          sourceType: sourceType,
          errorKind: "google_drive_invalid_image_link",
          userMessage: "ไม่สามารถดึงรูปภาพจากลิงก์ Google Drive ได้",
          technicalMessage:
            "ระบบเข้าถึง Google Drive ได้ แต่ไม่สามารถดึงรูปภาพจากลิงก์นี้ กรุณาตรวจสอบว่าเป็นลิงก์ไฟล์รูปภาพโดยตรง ไม่ใช่ลิงก์โฟลเดอร์ เอกสาร หรือไฟล์ที่ไม่ใช่รูปภาพ"
        };
      }

      return {
        ok: false,
        sourceType: sourceType,
        errorKind: "external_image_fetch_failed",
        userMessage: "ไม่สามารถดึงรูปภาพจากลิงก์นี้ได้",
        technicalMessage:
          "ระบบไม่สามารถดึงรูปภาพจาก URL นี้ได้ กรุณาตรวจสอบว่าลิงก์เปิดได้จริง เป็นลิงก์รูปภาพโดยตรง และไม่ได้ถูกบล็อกการเข้าถึง"
      };
    }

    return {
      ok: true,
      blob: validated.blob,
      mimeType: validated.mimeType,
      bytesLength: validated.bytesLength,
      sourceType: sourceType
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);

    if (sourceType === "google_drive") {
      return {
        ok: false,
        sourceType: sourceType,
        errorKind: "google_drive_no_access",
        userMessage: "ไม่สามารถเข้าถึงรูปภาพจาก Google Drive ได้",
        technicalMessage:
          "ไม่สามารถเข้าถึงไฟล์ Google Drive นี้ได้ กรุณาแชร์ไฟล์ให้ ai@convertcake.com แล้วลองรันใหม่อีกครั้ง"
      };
    }

    return {
      ok: false,
      sourceType: sourceType,
      errorKind: "external_image_fetch_failed",
      userMessage: "ไม่สามารถดึงรูปภาพจากลิงก์นี้ได้",
      technicalMessage:
        "ระบบไม่สามารถดึงรูปภาพจาก URL นี้ได้ กรุณาตรวจสอบว่าลิงก์เปิดได้จริง เป็นลิงก์รูปภาพโดยตรง และไม่ได้ถูกบล็อกการเข้าถึง (" + msg + ")"
    };
  }
}

function fetchDriveImageBlob_(fileId) {
  let driveAppAccess = false;

  try {
    const file = DriveApp.getFileById(fileId);
    driveAppAccess = true;
    const blob = file.getBlob();
    const validated = validateImageBlob_(blob);
    if (validated.ok) {
      return { ok: true, blob: validated.blob, mimeType: validated.mimeType };
    }
    Logger.log(
      "DriveApp fetch returned non-image bytes; hexPreview=" +
      bytesHexPreview_(blob.getBytes(), 12)
    );
  } catch (e1) {
    Logger.log("DriveApp failed: " + e1.message);
  }

  try {
    const directUrl = "https://drive.google.com/uc?export=download&id=" + fileId;
    const res = UrlFetchApp.fetch(directUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      const blob = res.getBlob();
      const validated = validateImageBlob_(blob);
      if (validated.ok) {
        return { ok: true, blob: validated.blob, mimeType: validated.mimeType };
      }
      Logger.log(
        "Drive direct fetch returned non-image bytes; hexPreview=" +
        bytesHexPreview_(blob.getBytes(), 12)
      );
    }
  } catch (e2) {
    Logger.log("Drive direct fetch failed: " + e2.message);
  }

  if (!driveAppAccess) {
    return {
      ok: false,
      sourceType: "google_drive",
      errorKind: "google_drive_no_access",
      userMessage: "ไม่สามารถเข้าถึงรูปภาพจาก Google Drive ได้",
      technicalMessage:
        "ไม่สามารถเข้าถึงไฟล์ Google Drive นี้ได้ กรุณาแชร์ไฟล์ให้ ai@convertcake.com แล้วลองรันใหม่อีกครั้ง"
    };
  }

  return {
    ok: false,
    sourceType: "google_drive",
    errorKind: "google_drive_invalid_image_link",
    userMessage: "ไม่สามารถดึงรูปภาพจากลิงก์ Google Drive ได้",
    technicalMessage:
      "ระบบเข้าถึง Google Drive ได้ แต่ไม่สามารถดึงรูปภาพจากลิงก์นี้ กรุณาตรวจสอบว่าเป็นลิงก์ไฟล์รูปภาพโดยตรง ไม่ใช่ลิงก์โฟลเดอร์ เอกสาร หรือไฟล์ที่ไม่ใช่รูปภาพ"
  };
}

function fetchExternalImageBlob_(url) {
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("HTTP " + code);
  }

  return res.getBlob();
}

function byteAt_(bytes, index) {
  if (!bytes || index < 0 || index >= bytes.length) {
    return -1;
  }
  return bytes[index] & 0xFF;
}

function hasAsciiSignature_(bytes, offset, text) {
  const sig = String(text || "");
  if (!bytes || !sig.length || offset < 0 || offset + sig.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < sig.length; i++) {
    if (byteAt_(bytes, offset + i) !== sig.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function detectImageMimeTypeFromBytes_(bytes) {
  if (!bytes || !bytes.length) {
    return null;
  }

  if (byteAt_(bytes, 0) === 0xFF && byteAt_(bytes, 1) === 0xD8 && byteAt_(bytes, 2) === 0xFF) {
    return "image/jpeg";
  }

  if (
    byteAt_(bytes, 0) === 0x89 &&
    byteAt_(bytes, 1) === 0x50 &&
    byteAt_(bytes, 2) === 0x4E &&
    byteAt_(bytes, 3) === 0x47 &&
    byteAt_(bytes, 4) === 0x0D &&
    byteAt_(bytes, 5) === 0x0A &&
    byteAt_(bytes, 6) === 0x1A &&
    byteAt_(bytes, 7) === 0x0A
  ) {
    return "image/png";
  }

  if (hasAsciiSignature_(bytes, 0, "GIF87a") || hasAsciiSignature_(bytes, 0, "GIF89a")) {
    return "image/gif";
  }

  if (hasAsciiSignature_(bytes, 0, "RIFF") && hasAsciiSignature_(bytes, 8, "WEBP")) {
    return "image/webp";
  }

  return null;
}

function bytesHexPreview_(bytes, maxLen) {
  const limit = Math.max(0, Number(maxLen) || 12);
  if (!bytes || !bytes.length) {
    return "";
  }
  const n = Math.min(bytes.length, limit);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const hex = (byteAt_(bytes, i)).toString(16);
    parts.push(hex.length === 1 ? "0" + hex : hex);
  }
  return parts.join(" ");
}

function validateImageBlob_(blob) {
  if (!blob) {
    Logger.log("validateImageBlob_: rejected (missing blob)");
    return { ok: false };
  }

  const bytes = blob.getBytes();
  if (!bytes || !bytes.length) {
    Logger.log("validateImageBlob_: rejected (empty bytes)");
    return { ok: false };
  }

  const hexPreview = bytesHexPreview_(bytes, 12);
  const detectedMime = detectImageMimeTypeFromBytes_(bytes);

  Logger.log(`validateImageBlob_: bytesLength=${bytes.length}`);
  Logger.log(`validateImageBlob_: hexPreview=${hexPreview}`);

  if (!detectedMime) {
    Logger.log("validateImageBlob_: rejected (no image signature)");
    return { ok: false };
  }

  Logger.log(`validateImageBlob_: detectedMime=${detectedMime}`);

  return {
    ok: true,
    blob: Utilities.newBlob(bytes, detectedMime),
    mimeType: detectedMime,
    bytesLength: bytes.length
  };
}

function isGoogleDriveFolderUrl_(url) {
  return /drive\.google\.com\/(?:drive\/)?folders\//i.test(url) ||
    /[?&]folder/i.test(url);
}

function extractDriveFileId_(url) {
  if (!url) return null;

  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/open\?id=([a-zA-Z0-9_-]+)/,
    /\/uc\?[^#]*id=([a-zA-Z0-9_-]+)/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = String(url).match(patterns[i]);
    if (m && m[1]) return m[1];
  }

  return null;
}

/* =====================================================================
 * RULES BLOCK BUILDING
 * ===================================================================== */

function buildRulesBlock_(rows, options) {
  options = options || {};
  const maxRules = options.maxRules || 100;

  const filtered = (rows || [])
    .slice(0, maxRules)
    .map(r => normalizeRuleForPrompt_(r));

  return JSON.stringify(filtered, null, 2);
}

function normalizeRuleForPrompt_(r) {
  const ruleId = r.rule_id || r.id || "";

  return {
    rule_id: ruleId,
    rule_title: r.rule_title || "",
    rule_text: r.rule_text || "",
    fix_note: r.fix_note || "",
    raw_rule_from_src: r.raw_rule_from_src || "",

    retrieval: {
      match_source: r.match_source || "",
      similarity: r.similarity !== undefined && r.similarity !== null ? r.similarity : "",
      distance: r.distance !== undefined && r.distance !== null ? r.distance : ""
    },
    reference: {
      src_id: r.src_id || "",
      src_display: r.src_display || "",
      src_locator: r.src_locator || "",
      reference_locator: r.src_locator || "",
      reference_section: r.src_display || ""
    }
  };
}

function parseJsonMaybe_(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function debugRulesBlock() {
  const retrievalConfig = getPolicyRetrievalConfig_();
  const rows = getRelevantPolicyRulesForRow_({
    retrievalText: "ลดน้ำหนัก 10 โลใน 7 วัน เห็นผลชัวร์ รับประกัน",
    retrievalConfig: retrievalConfig,
    cache: {},
    systemRow: "debug"
  });
  const rulesBlock = buildRulesBlock_(rows, { maxRules: retrievalConfig.maxRules });

  const samplePrompt = `
คุณคือ compliance checker
กรุณาใช้กฎต่อไปนี้:
{{rules_block}}
  `.trim();

  const finalPrompt = buildPromptText_(samplePrompt, {
    rulesBlock: rulesBlock,
    quickReferenceBlock: buildQuickReferenceBlock_(),
    message: ""
  });

  Logger.log(finalPrompt);

  return rulesBlock;
}

function debugVectorPolicySearch() {
  const testText = "ลดน้ำหนัก 10 โลใน 7 วัน เห็นผลชัวร์ รับประกัน";
  const retrievalConfig = getPolicyRetrievalConfig_();

  const rows = getRelevantPolicyRulesForRow_({
    retrievalText: testText,
    retrievalConfig,
    cache: {},
    systemRow: "debug"
  });

  Logger.log(JSON.stringify(rows.slice(0, 10), null, 2));
  return rows;
}

/* =====================================================================
 * QUICK REFERENCE BLOCK
 * Keep this as secondary guidance. RULES_BLOCK is primary.
 * ===================================================================== */

function buildQuickReferenceBlock_() {
  const block = {
    priority_note: [
      "Use this block as secondary guidance only. RULES_BLOCK remains the primary authority for explicit fail findings, fail decision support, rule_id, and formal citations.",
      "If RULES_BLOCK is incomplete, use this block to infer business context, likely approvals, required disclosures, platform special checks, and safer wording.",
      "Do not invent section, clause, article, announcement number, or Royal Gazette detail from this block alone."
    ],
    industry_guides: [
      {
        business_group: "คลินิกความงาม / สถานพยาบาล",
        prohibited_items: [
          "ห้าม Before/After",
          "ห้ามอ้างผลการรักษา",
          "ห้ามแพทย์โฆษณาเอง",
          "ห้ามใช้คำว่า 'ชะลอวัย' หรือ 'เป๊ะ ปัง'"
        ],
        approval_or_notice_required: [
          "ขออนุญาต สสจ. ทุกสาขา",
          "แสดงเลขอนุมัติในโฆษณา",
          "แพทยสภาอนุมัติก่อน"
        ],
        allowed_or_best_practice: [
          "ใช้คำว่า 'แลดูเด็กลง'",
          "อ้างแบรนด์ผลิตภัณฑ์",
          "ใส่ข้อมูลใบอนุญาตสถานพยาบาล"
        ],
        platform_special: [
          "Health & Wellness",
          "จำกัด Event Tracking"
        ],
        major_laws_or_policies: [
          "พ.ร.บ.สถานพยาบาล 2541",
          "ประกาศแพทยสภา 2567"
        ]
      },
      {
        business_group: "ยา / อาหารเสริม / Supplement",
        prohibited_items: [
          "ห้ามอ้างรักษาโรค",
          "ห้ามโฆษณายาโดยไม่ได้รับอนุญาต",
          "ห้ามโฆษณาในโรคต้องห้าม"
        ],
        approval_or_notice_required: [
          "ขออนุญาต อย. ก่อนโฆษณา",
          "แสดงเลขทะเบียน อย.",
          "ผ่านการอนุมัติโฆษณาก่อน"
        ],
        allowed_or_best_practice: [
          "ใช้คำว่า 'ช่วยบำรุง' ไม่ใช่ 'รักษา'",
          "แสดงคำเตือน อย.",
          "ระบุส่วนประกอบครบถ้วน"
        ],
        platform_special: [
          "Health & Wellness",
          "จำกัด Pixel"
        ],
        major_laws_or_policies: [
          "พ.ร.บ.ยา 2510",
          "พ.ร.บ.อาหาร 2522",
          "ประกาศ อย."
        ]
      },
      {
        business_group: "เครื่องสำอาง / Beauty (non-medical)",
        prohibited_items: [
          "ห้ามอ้างสรรพคุณทางยา",
          "ห้ามใช้คำว่า 'รักษา'",
          "ห้าม Body Shaming"
        ],
        approval_or_notice_required: [
          "จดแจ้ง อย. ก่อน",
          "โฆษณาต้องตรงกับฉลากจดแจ้ง",
          "KOL ต้อง tag Branded Content"
        ],
        allowed_or_best_practice: [
          "ใช้คำว่า 'บำรุง' แทน 'รักษา'",
          "อ้างผลการทดสอบได้ถ้ามีหลักฐาน",
          "แสดงส่วนประกอบหลัก"
        ],
        platform_special: [
          "ปกติไม่ใช่ Special Category",
          "แต่ระวัง Health & Wellness"
        ],
        major_laws_or_policies: [
          "พ.ร.บ.เครื่องสำอาง 2558",
          "หลักเกณฑ์ อย."
        ]
      },
      {
        business_group: "การเงิน / สินเชื่อ / ประกันภัย / ลงทุน / Crypto",
        prohibited_items: [
          "ห้ามการันตีผลตอบแทน",
          "ห้ามโฆษณาว่า 'ไม่มีความเสี่ยง'",
          "ห้าม Get Rich Quick",
          "ห้ามการันตีกำไร"
        ],
        approval_or_notice_required: [
          "ขออนุมัติ คปภ. สำหรับประกัน",
          "ต้องมีใบอนุญาตผู้แนะนำลงทุนเมื่อเกี่ยวข้อง",
          "Crypto ต้องขอ Written Permission จาก Meta ถ้าเข้าเงื่อนไข"
        ],
        allowed_or_best_practice: [
          "มีคำเตือนความเสี่ยง",
          "ระบุเงื่อนไขครบถ้วน",
          "ไม่สัญญาผลลัพธ์"
        ],
        platform_special: [
          "Special Ad Category: Financial Products",
          "Cryptocurrency Policy"
        ],
        major_laws_or_policies: [
          "ประกาศ ก.ล.ต.",
          "ประกาศ คปภ.",
          "Meta Financial Products Policy",
          "Meta Cryptocurrency Policy"
        ]
      },
      {
        business_group: "การพนัน / Lottery",
        prohibited_items: [
          "การพนันออนไลน์ผิดกฎหมายไทย",
          "ห้ามโฆษณาเด็ดขาดในไทย"
        ],
        approval_or_notice_required: [
          "Meta ต้องขอ Written Permission",
          "ต้องมีใบอนุญาตรัฐบาลท้องถิ่น",
          "Target 18+ เท่านั้น"
        ],
        allowed_or_best_practice: [
          "สลากกินแบ่งรัฐบาลทำได้ตามกรอบกฎหมาย",
          "ต้องไม่เกินราคาหน้าสลาก"
        ],
        platform_special: [
          "Gambling Policy",
          "Written Permission Required"
        ],
        major_laws_or_policies: [
          "พ.ร.บ.การพนัน 2478",
          "Meta Gambling Policy"
        ]
      },
      {
        business_group: "ฟิตเนส / Weight Loss / Wellness",
        prohibited_items: [
          "ห้าม Before/After images",
          "ห้าม guaranteed results",
          "ห้ามอ้างรักษาโรคอ้วน",
          "ห้ามทำให้ผู้ชมรู้สึกแย่กับรูปร่าง"
        ],
        approval_or_notice_required: [
          "Supplement ต้องมีเลข อย.",
          "อยู่ใน Meta Health & Wellness category",
          "KOL ต้องใช้ Branded Content Tool"
        ],
        allowed_or_best_practice: [
          "เน้น Lifestyle มากกว่า Weight Loss",
          "หลีกเลี่ยงตัวเลขผลลัพธ์เฉพาะบุคคล",
          "หลีกเลี่ยงภาพเปรียบเทียบก่อนหลัง"
        ],
        platform_special: [
          "Health & Wellness",
          "จำกัด Event Tracking และ Purchase Event"
        ],
        major_laws_or_policies: [
          "ประกาศ อย.",
          "Meta Weight Loss Policy"
        ]
      },
      {
        business_group: "PDPA / Data Privacy / ทุก Industry",
        prohibited_items: [
          "ห้ามเก็บข้อมูลโดยไม่ขอ Consent",
          "ห้าม Retarget โดยไม่มีฐานทางกฎหมาย",
          "ห้าม share ข้อมูลโดยไม่ได้รับอนุญาต"
        ],
        approval_or_notice_required: [
          "มี Privacy Notice บนเว็บไซต์",
          "มี Cookie Consent Banner",
          "ทำ DPIA สำหรับ High-Risk Processing"
        ],
        allowed_or_best_practice: [
          "บันทึก Consent timestamp",
          "ให้ผู้ใช้ถอน Consent ได้",
          "ลดข้อมูลที่ส่งผ่าน Pixel/CAPI เท่าที่จำเป็น"
        ],
        platform_special: [
          "ใช้กับทุก Industry ที่มี Pixel / Lead Form / Retargeting"
        ],
        major_laws_or_policies: [
          "พ.ร.บ. PDPA 2562",
          "Meta CAPI / Pixel Policy"
        ]
      }
    ]
  };

  return JSON.stringify(block, null, 2);
}

/* =====================================================================
 * SMALL UTILITIES
 * ===================================================================== */

function toCleanString_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function safeSlice_(s, maxLen) {
  s = String(s || "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

function formatUserFriendlyErrorMessage_(title, detail) {
  return [
    "เกิดข้อผิดพลาดระหว่างประมวลผล",
    "",
    "อาจเกิดจากสาเหตุชั่วคราว เช่น:",
    "- การเชื่อมต่อกับ Google Sheets / Drive / API ไม่เสถียร",
    "- ระบบใช้เวลารันนานเกินขีดจำกัดของ Apps Script",
    "- API ตอบกลับไม่สมบูรณ์ในรอบนี้",
    "",
    "โปรดลบผลการรันในแถวนี้ แล้วลองรันใหม่อีกครั้ง",
  ].join("\n");
}

function writeRowOutputError_(sheet, row, mode, scope, ctx) {
  ctx = ctx || {};
  const title = ctx.title || "ERROR";
  const detail = ctx.detail || "";
  const preservedImage = toCleanString_(ctx.revisedImage);
  const userFriendlyMessage = formatUserFriendlyErrorMessage_(title, detail);
  const shortStatus = toCleanString_(title) || "ERROR";

  Logger.log(`Row ${row} error title: ${title}`);
  Logger.log(`Row ${row} error detail: ${detail}`);
  Logger.log(`Row ${row} error scope: ${scope}, mode: ${mode}`);

  let revisedImage = preservedImage;
  let revisedCaption = "";
  let imageRationale = "";
  let captionRationale = "";

  if (scope === "caption") {
    revisedCaption = shortStatus;
    captionRationale = userFriendlyMessage;
  } else if (scope === "image") {
    if (!revisedImage) {
      revisedImage = shortStatus;
    }
    imageRationale = userFriendlyMessage;
  } else {
    if (mode === "image_only") {
      if (!revisedImage) {
        revisedImage = shortStatus;
      }
      imageRationale = userFriendlyMessage;
    } else if (mode === "caption_only") {
      revisedCaption = shortStatus;
      captionRationale = userFriendlyMessage;
    } else {
      revisedCaption = shortStatus;
      captionRationale = userFriendlyMessage;
      if (!revisedImage && mode === "both") {
        imageRationale = "";
      }
    }
  }

  writeAssessOutputRow_(sheet, row, {
    revisedImage: revisedImage,
    revisedCaption: revisedCaption,
    imageRationale: imageRationale,
    captionRationale: captionRationale
  });
}

function setRowErrorOutput_(sheet, row, title, detail) {
  writeRowOutputError_(sheet, row, "both", "caption", {
    revisedImage: "",
    title: title,
    detail: detail
  });
}

function formatImageFetchIssuesForRevisedImageCell_(issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) return "";

  const lines = [];

  lines.push("ไม่สามารถตรวจรูปภาพจากลิงก์ที่แปะมาได้");
  lines.push("");

  for (let i = 0; i < list.length; i++) {
    const issue = list[i] || {};
    const imageNo = issue.imageNumber || (i + 1);
    const kind = issue.errorKind || "unknown_image_fetch_failed";

    lines.push(`${issue.userMessage || "ไม่สามารถดึงรูปภาพจากลิงก์นี้ได้"}`);

    if (kind === "google_drive_no_access") {
      lines.push("- สาเหตุที่เป็นไปได้: ไฟล์ Google Drive ยังไม่ได้แชร์สิทธิ์ให้ระบบเข้าถึง");
      lines.push("- วิธีแก้: แชร์ไฟล์ให้ ai@convertcake.com แล้วลองรันใหม่อีกครั้ง");
    } else if (kind === "google_drive_invalid_image_link") {
      lines.push("- สาเหตุที่เป็นไปได้: ลิงก์ไม่ใช่ไฟล์รูปภาพโดยตรง อาจเป็นโฟลเดอร์ เอกสาร หรือไฟล์ชนิดอื่น");
      lines.push("- วิธีแก้: ใช้ลิงก์ไฟล์รูปภาพโดยตรง เช่น JPG / PNG / WEBP");
    } else if (kind === "external_image_fetch_failed") {
      lines.push("- สาเหตุที่เป็นไปได้: URL เปิดไม่ได้โดยตรง, เว็บบล็อกการดึงรูป, ลิงก์หมดอายุ หรือไม่ใช่ direct image URL");
      lines.push("- วิธีแก้: ใช้ลิงก์รูปภาพโดยตรง หรืออัปโหลดรูปไว้ใน Google Drive แล้วแชร์สิทธิ์ให้ระบบ");
    } else {
      lines.push("- สาเหตุที่เป็นไปได้: ระบบไม่สามารถอ่านลิงก์รูปภาพนี้ได้");
      lines.push("- วิธีแก้: ตรวจสอบว่าลิงก์เปิดได้จริงและเป็นไฟล์รูปภาพ");
    }

    if (i < list.length - 1) {
      lines.push("");
    }
  }

  lines.push("");
  lines.push("หลังแก้ไขลิงก์/สิทธิ์แล้ว ให้ลบผลการรันในแถวนี้ แล้วกด CHECK ใหม่อีกครั้ง");

  return lines.join("\n");
}

function isThaiVisualEquivalent_(a, b) {
  const original = toCleanString_(a);
  const suggested = toCleanString_(b);

  // Only treat as a (droppable) visual-equivalent case when both sides have text.
  if (!original || !suggested) return false;

  function norm(s) {
    return String(s || "")
      .replace(/\u0E33/g, "\u0E4D\u0E32")              // Sara Am -> Nikhahit + Sara Aa (canonical compare)
      .replace(/\u0E40\u0E40/g, "\u0E41")              // double Sara E -> Sara Ae
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")     // zero-width characters
      .toLowerCase()
      .trim();
  }

  return norm(original) === norm(suggested);
}

function normalizeSpellCheckFromAnalysis_(analysis) {
  const a = analysis || {};
  const sc = a.spell_check && typeof a.spell_check === "object"
    ? a.spell_check
    : {};

  const rawItems = Array.isArray(sc.items) ? sc.items : [];

  const items = rawItems
    .map(function(item, index) {
      item = item || {};
      return {
        order_index: Number(item.order_index) || (index + 1),
        original_text: toCleanString_(item.original_text),
        suggested_text: toCleanString_(item.suggested_text),
        error_type: toCleanString_(item.error_type),
        confidence: toCleanString_(item.confidence),
        explanation: toCleanString_(item.explanation)
      };
    })
    .filter(function(item) {
      return item.original_text || item.suggested_text || item.explanation;
    })
    .filter(function(item) {
      return !isThaiVisualEquivalent_(item.original_text, item.suggested_text);
    })
    .sort(function(a, b) {
      return a.order_index - b.order_index;
    });

  const notes = Array.isArray(sc.notes)
    ? sc.notes.map(toCleanString_).filter(Boolean)
    : [];

  const originalMessage = toCleanString_(a.original_message);
  const correctedMessage = toCleanString_(sc.corrected_message) || originalMessage;

  return {
    has_spelling_issues: Boolean(sc.has_spelling_issues) || items.length > 0,
    corrected_message: correctedMessage,
    items: items,
    notes: notes
  };
}

function formatSpellCheckBlock_(spellCheck) {
  const sc = spellCheck || {};
  const items = Array.isArray(sc.items) ? sc.items : [];
  const notes = Array.isArray(sc.notes) ? sc.notes : [];
  const hasIssues = Boolean(sc.has_spelling_issues) || items.length > 0;

  if (!hasIssues && !notes.length) {
    return "";
  }

  const lines = [];

  lines.push("Spell check:");

  if (!hasIssues) {
    lines.push("- ไม่พบคำผิดที่ชัดเจน");
  } else {
    lines.push(`- พบ ${items.length} จุดที่ควรแก้ไข`);

    const correctedMessage = toCleanString_(sc.corrected_message);
    if (correctedMessage) {
      lines.push("");
      lines.push("ข้อความที่แก้คำผิดแล้ว:");
      lines.push(correctedMessage);
    }

    if (items.length) {
      lines.push("");
      lines.push("รายการแก้ไข:");

      for (let i = 0; i < items.length; i++) {
        const item = items[i] || {};
        const originalText = toCleanString_(item.original_text) || "-";
        const suggestedText = toCleanString_(item.suggested_text) || "-";
        const errorType = toCleanString_(item.error_type) || "typo";
        const confidence = toCleanString_(item.confidence) || "medium";
        const explanation = toCleanString_(item.explanation) || "-";

        lines.push(`${i + 1}) [${errorType} | ${confidence}] ${originalText} → ${suggestedText}`);
        lines.push(`- เหตุผล: ${explanation}`);
      }
    }
  }

  if (notes.length) {
    lines.push("");
    lines.push("Spell check notes:");
    for (let j = 0; j < notes.length; j++) {
      lines.push(`- ${notes[j]}`);
    }
  }

  return lines.join("\n").trim();
}