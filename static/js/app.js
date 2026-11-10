/**
 * app.js
 * ------
 * Front-end application logic for the AI Object Removal tool.
 *
 * Responsibilities:
 *  - Drag-and-drop / click-to-browse image upload
 *  - Fabric.js canvas editor: brush + lasso masking, undo/redo, erase, zoom/pan
 *  - Talking to the Flask backend (/api/upload, /api/remove-object)
 *  - Before/after comparison slider + download
 *
 * The mask is drawn on a *transparent overlay* of red, semi-opaque strokes.
 * When submitting, we render just the mask strokes onto an off-screen
 * black/white canvas (white = selected-for-removal) and send that as a PNG
 * data URL to the backend.
 */

(() => {
    "use strict";

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------
    const state = {
        initialImageUrl: null,
        uploadedFilename: null,
        originalImageUrl: null,
        originalImageEl: null, // native <img> used to know true pixel dimensions
        fabricCanvas: null,
        fabricImage: null, // the background image object on the canvas
        currentTool: "brush", // "brush" | "lasso" | "erase"
        brushSize: 30,
        zoom: 1,
        isPanning: false,
        spacePressed: false,
        undoStack: [],
        redoStack: [],
        lassoPoints: [],
        lassoPolyline: null,
        isDrawingLasso: false,
        resultUrl: null,
        resultFilename: null,
    };

    const MAX_HISTORY = 30;

    // ---------------------------------------------------------------------
    // DOM references
    // ---------------------------------------------------------------------
    const el = {
        alertRegion: document.getElementById("alertRegion"),

        uploadSection: document.getElementById("uploadSection"),
        editorSection: document.getElementById("editorSection"),
        resultSection: document.getElementById("resultSection"),

        dropZone: document.getElementById("dropZone"),
        fileInput: document.getElementById("fileInput"),
        browseBtn: document.getElementById("browseBtn"),

        newImageBtn: document.getElementById("newImageBtn"),
        brushToolBtn: document.getElementById("brushToolBtn"),
        lassoToolBtn: document.getElementById("lassoToolBtn"),
        eraseToolBtn: document.getElementById("eraseToolBtn"),
        brushSize: document.getElementById("brushSize"),
        brushSizeLabel: document.getElementById("brushSizeLabel"),
        beforeBtn: document.getElementById("beforeBtn"),
        afterBtn: document.getElementById("afterBtn"),
        undoBtn: document.getElementById("undoBtn"),
        redoBtn: document.getElementById("redoBtn"),
        clearMaskBtn: document.getElementById("clearMaskBtn"),
        zoomInBtn: document.getElementById("zoomInBtn"),
        zoomOutBtn: document.getElementById("zoomOutBtn"),
        zoomResetBtn: document.getElementById("zoomResetBtn"),
        zoomLabel: document.getElementById("zoomLabel"),
        removeObjectBtn: document.getElementById("removeObjectBtn"),

        canvasContainer: document.getElementById("canvasContainer"),
        loadingOverlay: document.getElementById("loadingOverlay"),
        loadingText: document.getElementById("loadingText"),
        brushPreview: document.getElementById("brushPreview"),

        editAgainBtn: document.getElementById("editAgainBtn"),
        startOverBtn: document.getElementById("startOverBtn"),
        downloadBtn: document.getElementById("downloadBtn"),

        compareSlider: document.getElementById("compareSlider"),
        compareAfter: document.getElementById("compareAfter"),
        compareHandle: document.getElementById("compareHandle"),
        beforeImage: document.getElementById("beforeImage"),
        afterImage: document.getElementById("afterImage"),

        // New Features Elements
        singleModeTab: document.getElementById("singleModeTab"),
        batchModeTab: document.getElementById("batchModeTab"),
        dropZoneContainer: document.getElementById("dropZoneContainer"),
        batchZoneContainer: document.getElementById("batchZoneContainer"),
        batchDropZone: document.getElementById("batchDropZone"),
        batchFileInput: document.getElementById("batchFileInput"),
        batchBrowseBtn: document.getElementById("batchBrowseBtn"),
        batchOperationSelect: document.getElementById("batchOperationSelect"),
        batchQueueWrapper: document.getElementById("batchQueueWrapper"),
        batchCountBadge: document.getElementById("batchCountBadge"),
        clearBatchBtn: document.getElementById("clearBatchBtn"),
        batchItemsList: document.getElementById("batchItemsList"),
        batchProgressWrapper: document.getElementById("batchProgressWrapper"),
        batchProgressBar: document.getElementById("batchProgressBar"),
        startBatchProcessBtn: document.getElementById("startBatchProcessBtn"),
        downloadBatchZipBtn: document.getElementById("downloadBatchZipBtn"),

        smartDetectBtn: document.getElementById("smartDetectBtn"),
        removeBgBtn: document.getElementById("removeBgBtn"),
        enhanceModalBtn: document.getElementById("enhanceModalBtn"),
        detectedObjectsLayer: document.getElementById("detectedObjectsLayer"),
        detectedCountPill: document.getElementById("detectedCountPill"),
        detectedCountText: document.getElementById("detectedCountText"),

        sliderViewBtn: document.getElementById("sliderViewBtn"),
        sideBySideViewBtn: document.getElementById("sideBySideViewBtn"),
        sliderViewWrapper: document.getElementById("sliderViewWrapper"),
        sideBySideWrapper: document.getElementById("sideBySideWrapper"),
        sideBeforeImage: document.getElementById("sideBeforeImage"),
        sideAfterImage: document.getElementById("sideAfterImage"),

        applyEnhanceBtn: document.getElementById("applyEnhanceBtn"),
        enhanceDenoise: document.getElementById("enhanceDenoise"),
        enhanceSharpen: document.getElementById("enhanceSharpen"),
        enhanceContrast: document.getElementById("enhanceContrast"),

        statsModalBtn: document.getElementById("statsModalBtn"),
        statsModal: document.getElementById("statsModal"),
        historyDrawerBtn: document.getElementById("historyDrawerBtn"),
        historyListContainer: document.getElementById("historyListContainer"),
    };

    // ---------------------------------------------------------------------
    // Utility: alerts
    // ---------------------------------------------------------------------
    function showAlert(message, type = "danger", timeout = 5000) {
        const wrapper = document.createElement("div");
        wrapper.className = `alert alert-${type} alert-dismissible fade show`;
        wrapper.role = "alert";
        wrapper.innerHTML = `
            <div class="d-flex align-items-start gap-2">
                <i class="bi ${type === "danger" ? "bi-exclamation-triangle-fill" : "bi-check-circle-fill"}"></i>
                <div>${message}</div>
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        el.alertRegion.appendChild(wrapper);
        if (timeout) {
            setTimeout(() => wrapper.remove(), timeout);
        }
    }

    let loadingInterval = null;
    const loadingPhrases = [
        "Analyzing image context...",
        "Detecting mask contours...",
        "Synthesizing background textures with LaMa...",
        "Refining pixel details...",
        "Seamlessly blending inpainting boundaries..."
    ];

    function setLoading(isLoading, text = "Synthesizing Pixels with AI...") {
        if (el.loadingText) el.loadingText.textContent = text;
        if (el.loadingOverlay) el.loadingOverlay.classList.toggle("d-none", !isLoading);
        if (el.removeObjectBtn) el.removeObjectBtn.disabled = isLoading;

        if (isLoading) {
            let phraseIdx = 0;
            if (loadingInterval) clearInterval(loadingInterval);
            loadingInterval = setInterval(() => {
                phraseIdx = (phraseIdx + 1) % loadingPhrases.length;
                if (el.loadingText) el.loadingText.textContent = loadingPhrases[phraseIdx];
            }, 1800);
        } else {
            if (loadingInterval) {
                clearInterval(loadingInterval);
                loadingInterval = null;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Section navigation
    // ---------------------------------------------------------------------
    function showSection(name) {
        el.uploadSection.classList.toggle("d-none", name !== "upload");
        el.editorSection.classList.toggle("d-none", name !== "editor");
        el.resultSection.classList.toggle("d-none", name !== "result");

        // Sync step indicators
        const s1 = document.getElementById("stepIndicator1");
        const s2 = document.getElementById("stepIndicator2");
        const s3 = document.getElementById("stepIndicator3");
        if (s1 && s2 && s3) {
            s1.classList.toggle("active", name === "upload");
            s2.classList.toggle("active", name === "editor");
            s3.classList.toggle("active", name === "result");
        }

        // Celebratory confetti burst when reaching results
        if (name === "result" && typeof confetti === "function") {
            try {
                confetti({
                    particleCount: 55,
                    spread: 80,
                    origin: { y: 0.6 }
                });
            } catch (e) {
                // Ignore if confetti fails
            }
        }
    }

    // ---------------------------------------------------------------------
    // Upload handling
    // ---------------------------------------------------------------------
    function initUploadHandlers() {
        el.browseBtn.addEventListener("click", () => el.fileInput.click());
        el.dropZone.addEventListener("click", (e) => {
            if (e.target === el.browseBtn) return;
            el.fileInput.click();
        });

        el.fileInput.addEventListener("change", () => {
            if (el.fileInput.files.length) handleFile(el.fileInput.files[0]);
        });

        ["dragenter", "dragover"].forEach((evt) => {
            el.dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.dropZone.classList.add("drag-over");
            });
        });

        ["dragleave", "drop"].forEach((evt) => {
            el.dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.dropZone.classList.remove("drag-over");
            });
        });

        el.dropZone.addEventListener("drop", (e) => {
            const files = e.dataTransfer.files;
            if (files.length) handleFile(files[0]);
        });
    }

    function validateClientSide(file) {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        if (!allowed.includes(file.type)) {
            showAlert("Unsupported file type. Please upload a JPG, PNG, or WEBP image.");
            return false;
        }
        const maxBytes = 15 * 1024 * 1024;
        if (file.size > maxBytes) {
            showAlert("File is too large. Maximum allowed size is 15MB.");
            return false;
        }
        return true;
    }

    async function handleFile(file) {
        if (!validateClientSide(file)) return;

        const formData = new FormData();
        formData.append("image", file);

        setLoading(true, "Uploading image...");
        showSection("editor"); // reveal editor shell early so overlay has somewhere to render
        el.editorSection.classList.remove("d-none");

        try {
            const response = await fetch("/api/upload", { method: "POST", body: formData });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Upload failed. Please try again.");
            }

            state.initialImageUrl = data.url;
            state.uploadedFilename = data.filename;
            state.originalImageUrl = data.url;

            await initEditor(data.url);
            showSection("editor");
        } catch (err) {
            console.error(err);
            showAlert(err.message || "Something went wrong while uploading your image.");
            showSection("upload");
        } finally {
            setLoading(false);
        }
    }

    // ---------------------------------------------------------------------
    // Fabric.js editor
    // ---------------------------------------------------------------------
    async function initEditor(imageUrl) {
        // Load native image first to know intrinsic pixel dimensions.
        const nativeImg = await loadImageElement(imageUrl);
        state.originalImageEl = nativeImg;

        if (state.fabricCanvas) {
            state.fabricCanvas.dispose();
        }

        const canvasEl = document.getElementById("editorCanvas");
        const containerRect = el.canvasContainer.getBoundingClientRect();

        // Fit image within the visible container while preserving aspect ratio.
        const fitScale = Math.min(
            (containerRect.width - 40) / nativeImg.width,
            (containerRect.height - 40) / nativeImg.height,
            1
        );

        const displayWidth = Math.round(nativeImg.width * fitScale);
        const displayHeight = Math.round(nativeImg.height * fitScale);

        const canvas = new fabric.Canvas(canvasEl, {
            width: displayWidth,
            height: displayHeight,
            selection: false,
            backgroundColor: "#fff",
            fireRightClick: true,
            stopContextMenu: true,
        });
        state.fabricCanvas = canvas;
        state.zoom = 1;
        updateZoomLabel();

        const fabricImg = new fabric.Image(nativeImg, {
            left: 0,
            top: 0,
            selectable: false,
            evented: false,
            scaleX: displayWidth / nativeImg.width,
            scaleY: displayHeight / nativeImg.height,
        });
        state.fabricImage = fabricImg;
        canvas.add(fabricImg);
        canvas.renderOnAddRemove = true;

        // Free-draw (brush) config: red, semi-transparent strokes mark the mask.
        canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
        canvas.freeDrawingBrush.color = "rgba(239, 68, 68, 0.55)";
        canvas.freeDrawingBrush.width = state.brushSize;
        canvas.isDrawingMode = true;

        state.undoStack = [];
        state.redoStack = [];
        updateHistoryButtons();

        canvas.on("path:created", (e) => {
            e.path.selectable = false;
            e.path.evented = state.currentTool === "erase";
            
            if (state.currentTool !== "erase") {
                triggerLiveRemoval();
            }
        });

        canvas.on("mouse:down", handleCanvasMouseDown);
        canvas.on("mouse:move", handleCanvasMouseMove);
        canvas.on("mouse:up", handleCanvasMouseUp);
        canvas.on("mouse:wheel", handleCanvasWheel);

        // Wire up erase-click-to-delete and space-to-pan behavior now that
        // the canvas instance exists.
        initEraseClickHandler();
        initPanning();

        setTool("brush");
    }

    function loadImageElement(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }

    // ---- Tools --------------------------------------------------------

    function setTool(tool) {
        state.currentTool = tool;
        el.brushToolBtn.classList.toggle("active", tool === "brush");
        el.lassoToolBtn.classList.toggle("active", tool === "lasso");
        if (el.eraseToolBtn) el.eraseToolBtn.classList.toggle("active", tool === "erase");

        const currentToolTextEl = document.getElementById("currentToolText");
        if (currentToolTextEl) {
            if (tool === "brush") {
                currentToolTextEl.textContent = "Brush Mode: Paint over what you want gone";
            } else if (tool === "lasso") {
                currentToolTextEl.textContent = "Lasso Mode: Click points around object, click start to close";
            } else {
                currentToolTextEl.textContent = "Eraser Mode: Click a stroke to delete it";
            }
        }

        const canvas = state.fabricCanvas;
        if (!canvas) return;

        resetLassoDrawing();

        if (tool === "brush") {
            canvas.isDrawingMode = true;
            canvas.freeDrawingBrush.color = "rgba(239, 68, 68, 0.55)";
            canvas.freeDrawingBrush.width = state.brushSize;
            setObjectsEvented(false);
        } else if (tool === "erase") {
            canvas.isDrawingMode = false;
            setObjectsEvented(true);
        } else if (tool === "lasso") {
            canvas.isDrawingMode = false;
            setObjectsEvented(false);
        }
        
        updateBrushCursor();
    }

    function updateBrushCursor() {
        const canvas = state.fabricCanvas;
        if (!canvas) return;

        if (state.currentTool !== "brush") {
            canvas.freeDrawingCursor = "crosshair";
            canvas.defaultCursor = "default";
            canvas.requestRenderAll();
            return;
        }

        // Calculate visual size considering zoom
        const size = Math.max(4, Math.round(state.brushSize * state.zoom));
        const halfSize = size / 2;
        const hotspot = Math.round(halfSize);

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
            <circle cx="${halfSize}" cy="${halfSize}" r="${halfSize - 1}" fill="transparent" stroke="#ef4444" stroke-width="1.5"/>
        </svg>`;

        const cursorUrl = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, auto`;
        
        canvas.freeDrawingCursor = cursorUrl;
        canvas.defaultCursor = cursorUrl;
        canvas.requestRenderAll();
    }

    function setObjectsEvented(evented) {
        const canvas = state.fabricCanvas;
        canvas.getObjects().forEach((obj) => {
            if (obj === state.fabricImage) return;
            obj.evented = evented;
            obj.selectable = false; // never allow moving/resizing strokes, only deleting
            obj.hoverCursor = evented ? "pointer" : "default";
        });
    }

    // ---- Lasso / polygon tool ------------------------------------------

    function resetLassoDrawing() {
        const canvas = state.fabricCanvas;
        if (state.lassoPolyline && canvas) {
            canvas.remove(state.lassoPolyline);
        }
        state.lassoPoints = [];
        state.lassoPolyline = null;
        state.isDrawingLasso = false;
    }

    function handleCanvasMouseDown(opt) {
        const canvas = state.fabricCanvas;

        if (state.currentTool === "brush" && canvas.isDrawingMode) {
            const e = opt.e;
            if (e.button === 0 || e.touches) {
                pushHistory();
            }
            return;
        }

        if (state.currentTool !== "lasso" || state.spacePressed) return;
        const pointer = canvas.getPointer(opt.e);

        if (!state.isDrawingLasso) {
            state.isDrawingLasso = true;
            state.lassoPoints = [{ x: pointer.x, y: pointer.y }];
        } else {
            state.lassoPoints.push({ x: pointer.x, y: pointer.y });

            // Close the loop if the user clicks near the starting point.
            const start = state.lassoPoints[0];
            const dist = Math.hypot(pointer.x - start.x, pointer.y - start.y);
            if (state.lassoPoints.length > 2 && dist < 12 / state.zoom) {
                finalizeLasso();
                return;
            }
        }
        renderLassoPreview();
    }

    function handleCanvasMouseMove(opt) {
        if (state.currentTool !== "lasso" || !state.isDrawingLasso) return;
        const canvas = state.fabricCanvas;
        const pointer = canvas.getPointer(opt.e);
        const previewPoints = [...state.lassoPoints, { x: pointer.x, y: pointer.y }];
        renderLassoPreview(previewPoints);
    }

    function handleCanvasMouseUp() {
        /* no-op: lasso uses click-to-add-point interaction, not drag */
    }

    function renderLassoPreview(pointsOverride) {
        const canvas = state.fabricCanvas;
        const points = pointsOverride || state.lassoPoints;
        if (state.lassoPolyline) canvas.remove(state.lassoPolyline);

        state.lassoPolyline = new fabric.Polyline(points, {
            fill: "rgba(239, 68, 68, 0.35)",
            stroke: "#ef4444",
            strokeWidth: 2,
            selectable: false,
            evented: false,
            objectCaching: false,
        });
        canvas.add(state.lassoPolyline);
        canvas.renderAll();
    }

    function finalizeLasso() {
        pushHistory();
        const canvas = state.fabricCanvas;
        if (state.lassoPolyline) canvas.remove(state.lassoPolyline);

        const polygon = new fabric.Polygon(state.lassoPoints, {
            fill: "rgba(239, 68, 68, 0.55)",
            stroke: "rgba(239, 68, 68, 0.9)",
            strokeWidth: 1,
            selectable: false,
            evented: false,
            objectCaching: false,
        });
        canvas.add(polygon);
        canvas.renderAll();

        resetLassoDrawing();
        triggerLiveRemoval();
    }

    function handleLassoDoubleClick() {
        if (state.currentTool === "lasso" && state.isDrawingLasso && state.lassoPoints.length > 2) {
            finalizeLasso();
        }
    }

    // ---- Undo / Redo -----------------------------------------------------

    function pushHistory() {
        state.undoStack.push(currentSnapshot());
        if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
        state.redoStack = [];
        updateHistoryButtons();
    }

    function currentSnapshot() {
        const canvas = state.fabricCanvas;
        const maskObjects = canvas.getObjects().filter((o) => o !== state.fabricImage && o !== state.lassoPolyline);
        return {
            imageUrl: state.originalImageUrl,
            filename: state.uploadedFilename,
            maskSnapshot: JSON.stringify(maskObjects.map((o) => o.toObject()))
        };
    }

    async function restoreSnapshot(snapshot) {
        if (!snapshot) return;
        const canvas = state.fabricCanvas;

        // Restore image if changed
        if (snapshot.imageUrl !== state.originalImageUrl) {
            state.uploadedFilename = snapshot.filename;
            state.resultUrl = snapshot.imageUrl;
            state.originalImageUrl = snapshot.imageUrl;
            
            const newImg = await loadImageElement(snapshot.imageUrl);
            state.originalImageEl = newImg;
            
            const baseDisplayWidth = state.fabricImage.getScaledWidth();
            const baseDisplayHeight = state.fabricImage.getScaledHeight();
            
            await new Promise((resolve) => {
                state.fabricImage.setSrc(snapshot.imageUrl, () => {
                    state.fabricImage.set({
                        scaleX: baseDisplayWidth / newImg.width,
                        scaleY: baseDisplayHeight / newImg.height,
                    });
                    resolve();
                });
            });
        }

        // Restore masks
        canvas.getObjects()
            .filter((o) => o !== state.fabricImage)
            .forEach((o) => canvas.remove(o));

        const objects = JSON.parse(snapshot.maskSnapshot);
        if (!objects.length) {
            canvas.renderAll();
            return;
        }
        
        fabric.util.enlivenObjects(objects, (enlivened) => {
            enlivened.forEach((obj) => {
                obj.selectable = false;
                obj.evented = state.currentTool === "erase";
                canvas.add(obj);
            });
            canvas.renderAll();
        });
    }

    async function undo() {
        if (!state.undoStack.length) return;
        
        const snapshot = state.undoStack.pop();
        state.redoStack.push(currentSnapshot());
        await restoreSnapshot(snapshot);
        updateHistoryButtons();
    }

    async function redo() {
        if (!state.redoStack.length) return;
        
        const snapshot = state.redoStack.pop();
        state.undoStack.push(currentSnapshot());
        await restoreSnapshot(snapshot);
        updateHistoryButtons();
    }

    function updateHistoryButtons() {
        el.undoBtn.disabled = state.undoStack.length === 0;
        el.redoBtn.disabled = state.redoStack.length === 0;
    }

    function clearMask() {
        pushHistory();
        const canvas = state.fabricCanvas;
        canvas.getObjects()
            .filter((o) => o !== state.fabricImage)
            .forEach((o) => canvas.remove(o));
        canvas.renderAll();
    }

    // ---- Erase tool: click a stroke to delete it --------------------------

    function initEraseClickHandler() {
        const canvas = state.fabricCanvas;
        if (!canvas) return;
        canvas.on("mouse:down", (opt) => {
            if (state.currentTool !== "erase") return;
            const target = opt.target;
            if (target && target !== state.fabricImage) {
                canvas.remove(target);
                canvas.renderAll();
                pushHistory();
            }
        });
    }

    // ---- Zoom / Pan --------------------------------------------------------

    function applyZoom(newZoom, point) {
        const canvas = state.fabricCanvas;
        newZoom = Math.min(Math.max(newZoom, 1), 4);
        state.zoom = newZoom;
        
        if (point) {
            canvas.zoomToPoint(point, newZoom);
        } else {
            // Zoom to center if no point is provided (e.g. from buttons)
            canvas.zoomToPoint(new fabric.Point(canvas.width / 2, canvas.height / 2), newZoom);
        }

        // Reset panning exactly to top left when zoomed out fully
        if (newZoom === 1) {
            canvas.viewportTransform[4] = 0;
            canvas.viewportTransform[5] = 0;
            canvas.requestRenderAll();
        }

        updateZoomLabel();
        updateBrushCursor();
    }

    function updateZoomLabel() {
        const pct = `${Math.round(state.zoom * 100)}%`;
        if (el.zoomLabel) el.zoomLabel.textContent = pct;
        const zoomBadge = document.getElementById("zoomDisplayBadge");
        if (zoomBadge) zoomBadge.textContent = pct;
    }

    function handleCanvasWheel(opt) {
        const delta = opt.e.deltaY;
        let zoom = state.zoom * (delta > 0 ? 0.9 : 1.1);
        applyZoom(zoom, new fabric.Point(opt.e.offsetX, opt.e.offsetY));
        opt.e.preventDefault();
        opt.e.stopPropagation();
    }

    function initPanning() {
        const canvas = state.fabricCanvas;

        canvas.on("mouse:down", (opt) => {
            // Check if right click (e.button === 2 or opt.button === 3 depending on fabric.js version)
            const isRightClick = (opt.e && opt.e.button === 2) || (opt.button === 3);
            if (!isRightClick) return;

            state.isPanning = true;
            canvas.selection = false;
            canvas.isDrawingMode = false;
            el.canvasContainer.classList.add("panning");
            state._panStart = { x: opt.e.clientX, y: opt.e.clientY };
            
            if (opt.e.preventDefault) opt.e.preventDefault();
            if (opt.e.stopPropagation) opt.e.stopPropagation();
        });
        canvas.on("mouse:move", (opt) => {
            if (!state.isPanning) return;
            const e = opt.e;
            const dx = e.clientX - state._panStart.x;
            const dy = e.clientY - state._panStart.y;
            state._panStart = { x: e.clientX, y: e.clientY };
            const vpt = canvas.viewportTransform;
            vpt[4] += dx;
            vpt[5] += dy;
            canvas.requestRenderAll();
        });
        canvas.on("mouse:up", (opt) => {
            if (state.isPanning) {
                state.isPanning = false;
                el.canvasContainer.classList.remove("panning");
                if (state.currentTool === "brush") canvas.isDrawingMode = true;
            }
        });
    }

    async function toggleBeforeAfter(showBefore) {
        if (!state.fabricCanvas) return;
        const canvas = state.fabricCanvas;

        if (showBefore) {
            el.beforeBtn.classList.add("bg-white", "shadow-sm", "text-dark");
            el.beforeBtn.classList.remove("text-secondary");
            el.afterBtn.classList.remove("bg-white", "shadow-sm", "text-dark");
            el.afterBtn.classList.add("text-secondary");
        } else {
            el.afterBtn.classList.add("bg-white", "shadow-sm", "text-dark");
            el.afterBtn.classList.remove("text-secondary");
            el.beforeBtn.classList.remove("bg-white", "shadow-sm", "text-dark");
            el.beforeBtn.classList.add("text-secondary");
        }

        const targetUrl = showBefore ? state.initialImageUrl : state.originalImageUrl;
        const newImg = await loadImageElement(targetUrl);
        
        const maskObjects = canvas.getObjects().filter(o => o !== state.fabricImage);
        maskObjects.forEach(o => o.visible = !showBefore);

        if (showBefore) {
            state.wasDrawingMode = canvas.isDrawingMode;
            canvas.isDrawingMode = false;
        } else {
            if (state.wasDrawingMode) canvas.isDrawingMode = true;
        }

        const baseDisplayWidth = state.fabricImage.getScaledWidth();
        const baseDisplayHeight = state.fabricImage.getScaledHeight();
        
        state.fabricImage.setSrc(targetUrl, () => {
            state.fabricImage.set({
                scaleX: baseDisplayWidth / newImg.width,
                scaleY: baseDisplayHeight / newImg.height,
            });
            canvas.requestRenderAll();
        });
    }

    // ---------------------------------------------------------------------
    // Toolbar wiring
    // ---------------------------------------------------------------------
    function initToolbarHandlers() {
        el.beforeBtn.addEventListener("click", () => toggleBeforeAfter(true));
        el.afterBtn.addEventListener("click", () => toggleBeforeAfter(false));
        el.brushToolBtn.addEventListener("click", () => setTool("brush"));
        el.lassoToolBtn.addEventListener("click", () => setTool("lasso"));
        el.eraseToolBtn.addEventListener("click", () => setTool("erase"));

        let brushPreviewTimeout;
        el.brushSize.addEventListener("input", () => {
            state.brushSize = parseInt(el.brushSize.value, 10);
            if (el.brushSizeLabel) el.brushSizeLabel.textContent = state.brushSize;
            const sizeBadge = document.getElementById("brushSizeBadge");
            if (sizeBadge) sizeBadge.textContent = `${state.brushSize}px`;
            
            if (el.brushPreview) {
                const visualSize = Math.max(4, Math.round(state.brushSize * state.zoom));
                el.brushPreview.style.width = `${visualSize}px`;
                el.brushPreview.style.height = `${visualSize}px`;
                el.brushPreview.classList.remove("d-none");
                
                clearTimeout(brushPreviewTimeout);
                brushPreviewTimeout = setTimeout(() => {
                    el.brushPreview.classList.add("d-none");
                }, 800);
            }

            if (state.fabricCanvas && state.fabricCanvas.freeDrawingBrush) {
                state.fabricCanvas.freeDrawingBrush.width = state.brushSize;
                updateBrushCursor();
            }
        });

        el.undoBtn.addEventListener("click", undo);
        el.redoBtn.addEventListener("click", redo);
        el.clearMaskBtn.addEventListener("click", clearMask);

        el.zoomInBtn.addEventListener("click", () => applyZoom(state.zoom * 1.2));
        el.zoomOutBtn.addEventListener("click", () => applyZoom(state.zoom * 0.8));
        el.zoomResetBtn.addEventListener("click", () => applyZoom(1));

        el.removeObjectBtn.addEventListener("click", submitRemoveObject);
        el.newImageBtn.addEventListener("click", resetToUpload);

        document.addEventListener("keydown", (e) => {
            if (el.editorSection.classList.contains("d-none")) return;
            const ctrlOrCmd = e.ctrlKey || e.metaKey;
            if (ctrlOrCmd && e.key.toLowerCase() === "z" && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if (ctrlOrCmd && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
                e.preventDefault();
                redo();
            }
        });

        el.canvasContainer.addEventListener("dblclick", handleLassoDoubleClick);
    }

    // ---------------------------------------------------------------------
    // Mask export: render mask strokes to a black/white PNG at ORIGINAL
    // image resolution (not the possibly-scaled-down display resolution).
    // ---------------------------------------------------------------------
    function exportMaskDataUrl() {
        const canvas = state.fabricCanvas;
        const img = state.fabricImage;

        const nativeWidth = state.originalImageEl.naturalWidth;
        const nativeHeight = state.originalImageEl.naturalHeight;

        // Scale factor from the *unzoomed* display canvas to native resolution.
        const baseDisplayWidth = img.getScaledWidth();
        const baseDisplayHeight = img.getScaledHeight();
        const scaleX = nativeWidth / baseDisplayWidth;
        const scaleY = nativeHeight / baseDisplayHeight;

        const maskCanvasEl = document.createElement("canvas");
        maskCanvasEl.width = nativeWidth;
        maskCanvasEl.height = nativeHeight;
        const maskFabric = new fabric.StaticCanvas(maskCanvasEl, {
            backgroundColor: "#000000",
        });

        const maskObjects = canvas.getObjects().filter((o) => o !== img);

        maskObjects.forEach((obj) => {
            const serialized = obj.toObject();
            // Re-instantiate via enlivenObjects to get a fresh fabric object,
            // then scale it into native-resolution mask space and paint white.
            fabric.util.enlivenObjects([serialized], (enlivenedArr) => {
                const enlivened = enlivenedArr[0];
                enlivened.set({
                    left: enlivened.left * scaleX,
                    top: enlivened.top * scaleY,
                    scaleX: enlivened.scaleX * scaleX,
                    scaleY: enlivened.scaleY * scaleY,
                    fill: "#ffffff",
                    stroke: "#ffffff",
                    opacity: 1,
                });
                maskFabric.add(enlivened);
                maskFabric.renderAll();
            });
        });

        // enlivenObjects is async but effectively synchronous for simple
        // shapes (path/polygon) with no external images, so a microtask
        // flush via toDataURL immediately after is safe in practice; to be
        // fully robust we wrap the whole export in a short promise below.
        return new Promise((resolve) => {
            setTimeout(() => {
                maskFabric.renderAll();
                resolve(maskCanvasEl.toDataURL("image/png"));
            }, 50);
        });
    }

    // ---------------------------------------------------------------------
    // Submit to backend for AI inpainting
    // ---------------------------------------------------------------------
    async function triggerLiveRemoval() {
        const canvas = state.fabricCanvas;
        const maskObjects = canvas.getObjects().filter((o) => o !== state.fabricImage);

        if (!maskObjects.length) return;

        setLoading(true, "Removing object with AI...");
        const wasDrawingMode = canvas.isDrawingMode;
        canvas.isDrawingMode = false;

        try {
            const maskDataUrl = await exportMaskDataUrl();

            const response = await fetch("/api/remove-object", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: state.uploadedFilename,
                    mask: maskDataUrl,
                }),
            });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "AI processing failed. Please try again.");
            }

            // Update state with new image
            state.uploadedFilename = data.result_filename;
            state.resultUrl = data.result_url;
            state.resultFilename = data.result_filename;
            
            // Seamlessly replace the background image
            const newImg = await loadImageElement(data.result_url);
            state.originalImageEl = newImg;
            
            const baseDisplayWidth = state.fabricImage.getScaledWidth();
            const baseDisplayHeight = state.fabricImage.getScaledHeight();
            
            state.fabricImage.setSrc(data.result_url, () => {
                state.fabricImage.set({
                    scaleX: baseDisplayWidth / newImg.width,
                    scaleY: baseDisplayHeight / newImg.height,
                });
                state.originalImageUrl = data.result_url;
                
                // Remove mask objects from canvas without pushHistory
                maskObjects.forEach((o) => canvas.remove(o));
                
                updateHistoryButtons();
                
                if (wasDrawingMode && state.currentTool === "brush") {
                    canvas.isDrawingMode = true;
                }
                canvas.renderAll();

                // Subtle celebratory micro-confetti burst
                if (typeof confetti === "function") {
                    try {
                        confetti({
                            particleCount: 20,
                            spread: 50,
                            origin: { y: 0.7 }
                        });
                    } catch (e) {}
                }
            });

        } catch (err) {
            console.error(err);
            showAlert(err.message || "Failed to remove object.");
            if (wasDrawingMode && state.currentTool === "brush") {
                canvas.isDrawingMode = true;
            }
        } finally {
            setLoading(false);
        }
    }

    async function submitRemoveObject() {
        if (!state.resultUrl && state.originalImageUrl === state.initialImageUrl) {
            showAlert("Please brush over the object you want to remove before continuing.", "warning");
            return;
        }

        // We use initial image for Before, and the latest originalImage (or result) for After.
        el.beforeImage.src = state.initialImageUrl;
        el.afterImage.src = state.resultUrl || state.originalImageUrl;
        if (el.sideBeforeImage) el.sideBeforeImage.src = state.initialImageUrl;
        if (el.sideAfterImage) el.sideAfterImage.src = state.resultUrl || state.originalImageUrl;
        resetCompareSlider();

        showSection("result");
    }

    // ---------------------------------------------------------------------
    // Before/After comparison slider
    // ---------------------------------------------------------------------
    function resetCompareSlider() {
        el.compareAfter.style.clipPath = "inset(0 0 0 50%)";
        el.compareHandle.style.left = "50%";
    }

    function initCompareSlider() {
        let dragging = false;

        const setPosition = (clientX) => {
            const rect = el.compareSlider.getBoundingClientRect();
            let pct = ((clientX - rect.left) / rect.width) * 100;
            pct = Math.min(Math.max(pct, 0), 100);
            el.compareAfter.style.clipPath = `inset(0 0 0 ${pct}%)`;
            el.compareHandle.style.left = `${pct}%`;
        };

        el.compareHandle.addEventListener("mousedown", () => (dragging = true));
        window.addEventListener("mouseup", () => (dragging = false));
        window.addEventListener("mousemove", (e) => {
            if (dragging) setPosition(e.clientX);
        });

        el.compareHandle.addEventListener("touchstart", () => (dragging = true), { passive: true });
        window.addEventListener("touchend", () => (dragging = false));
        window.addEventListener(
            "touchmove",
            (e) => {
                if (dragging && e.touches.length) setPosition(e.touches[0].clientX);
            },
            { passive: true }
        );

        el.compareSlider.addEventListener("click", (e) => {
            if (e.target.closest(".compare-handle-circle")) return;
            setPosition(e.clientX);
        });
    }

    // ---------------------------------------------------------------------
    // Result actions: download, edit again, start over
    // ---------------------------------------------------------------------
    function initResultHandlers() {
        el.downloadBtn.addEventListener("click", () => {
            if (!state.resultFilename) return;
            const link = document.createElement("a");
            link.href = `/api/download/${encodeURIComponent(state.resultFilename)}`;
            link.download = state.resultFilename;
            document.body.appendChild(link);
            link.click();
            link.remove();
        });

        el.editAgainBtn.addEventListener("click", () => {
            showSection("editor");
        });

        el.startOverBtn.addEventListener("click", resetToUpload);
    }

    function resetToUpload() {
        state.uploadedFilename = null;
        state.originalImageUrl = null;
        state.resultUrl = null;
        state.resultFilename = null;
        el.fileInput.value = "";
        if (state.fabricCanvas) {
            state.fabricCanvas.dispose();
            state.fabricCanvas = null;
        }
        showSection("upload");
    }

    // ---------------------------------------------------------------------
    // Feature 1: Smart Object Detection
    // ---------------------------------------------------------------------
    let currentDetectedObjects = [];

    async function runObjectDetection() {
        if (!state.uploadedFilename) return;
        setLoading(true, "Scanning scene for objects with AI...");

        try {
            const response = await fetch("/api/detect-objects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: state.uploadedFilename, threshold: 0.35 }),
            });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Failed to detect objects.");
            }

            currentDetectedObjects = data.objects || [];
            renderDetectedObjectsOverlay(currentDetectedObjects);

            if (el.detectedCountPill && el.detectedCountText) {
                el.detectedCountText.textContent = `${currentDetectedObjects.length} Objects Detected`;
                el.detectedCountPill.classList.remove("d-none");
            }

            showAlert(`Detected ${currentDetectedObjects.length} objects! Click any tag on the photo to select and mask it.`, "success", 6000);
        } catch (err) {
            console.error(err);
            showAlert(err.message || "Object detection failed.");
        } finally {
            setLoading(false);
        }
    }

    function renderDetectedObjectsOverlay(objects) {
        if (!el.detectedObjectsLayer || !state.fabricCanvas) return;
        el.detectedObjectsLayer.innerHTML = "";
        el.detectedObjectsLayer.classList.remove("d-none");

        const canvasRect = el.canvasContainer.getBoundingClientRect();
        const canvas = state.fabricCanvas;
        const img = state.fabricImage;
        if (!img) return;

        const baseDisplayWidth = img.getScaledWidth();
        const baseDisplayHeight = img.getScaledHeight();

        objects.forEach((obj) => {
            const [nx1, ny1, nx2, ny2] = obj.box_normalized;
            const badge = document.createElement("button");
            badge.className = "detected-tag-badge";
            badge.type = "button";
            badge.innerHTML = `<i class="bi bi-bounding-box me-1"></i> ${obj.label} (${Math.round(obj.score * 100)}%)`;

            // Position badge near top-left of object inside canvas container
            badge.style.left = `${Math.round(nx1 * baseDisplayWidth + 10)}px`;
            badge.style.top = `${Math.round(ny1 * baseDisplayHeight + 10)}px`;

            badge.addEventListener("click", (e) => {
                e.stopPropagation();
                selectDetectedObject(obj);
            });

            el.detectedObjectsLayer.appendChild(badge);
        });
    }

    function selectDetectedObject(obj) {
        if (!state.fabricCanvas || !state.fabricImage) return;
        pushHistory();
        const canvas = state.fabricCanvas;
        const img = state.fabricImage;
        const [nx1, ny1, nx2, ny2] = obj.box_normalized;

        const baseDisplayWidth = img.getScaledWidth();
        const baseDisplayHeight = img.getScaledHeight();

        const x = nx1 * baseDisplayWidth;
        const y = ny1 * baseDisplayHeight;
        const w = (nx2 - nx1) * baseDisplayWidth;
        const h = (ny2 - ny1) * baseDisplayHeight;

        const rect = new fabric.Rect({
            left: x,
            top: y,
            width: w,
            height: h,
            fill: "rgba(239, 68, 68, 0.55)",
            stroke: "#ef4444",
            strokeWidth: 2,
            selectable: false,
            evented: state.currentTool === "erase",
        });

        canvas.add(rect);
        canvas.renderAll();

        showAlert(`Selected "${obj.label}". Click 'Review & Export' to erase it with AI!`, "info", 5000);
    }

    // ---------------------------------------------------------------------
    // Feature 2: Background Removal (Transparent PNG)
    // ---------------------------------------------------------------------
    async function runBackgroundRemoval() {
        if (!state.uploadedFilename) return;
        setLoading(true, "Extracting subject & removing background with AI...");

        try {
            const response = await fetch("/api/remove-background", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: state.uploadedFilename }),
            });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Background removal failed.");
            }

            await updateCanvasImage(data.result_url, data.result_filename);
            showAlert("Background removed! Displaying transparent cutout.", "success");

            if (typeof confetti === "function") {
                confetti({ particleCount: 40, spread: 70, origin: { y: 0.65 } });
            }
        } catch (err) {
            console.error(err);
            showAlert(err.message || "Background removal failed.");
        } finally {
            setLoading(false);
        }
    }

    // ---------------------------------------------------------------------
    // Feature 3: AI Image Enhancement
    // ---------------------------------------------------------------------
    async function runImageEnhancement() {
        if (!state.uploadedFilename) return;

        const scaleRadio = document.querySelector('input[name="enhanceScale"]:checked');
        const scale = scaleRadio ? parseInt(scaleRadio.value, 10) : 2;
        const denoise = el.enhanceDenoise ? el.enhanceDenoise.checked : true;
        const sharpen = el.enhanceSharpen ? el.enhanceSharpen.checked : true;
        const contrast = el.enhanceContrast ? el.enhanceContrast.checked : true;

        const enhanceModalEl = document.getElementById("enhanceModal");
        if (enhanceModalEl && window.bootstrap) {
            const modalInstance = bootstrap.Modal.getInstance(enhanceModalEl);
            if (modalInstance) modalInstance.hide();
        }

        setLoading(true, `Applying AI enhancement (${scale}x Super-Resolution, Denoise, Sharpen)...`);

        try {
            const response = await fetch("/api/enhance-image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: state.uploadedFilename,
                    scale: scale,
                    denoise: denoise,
                    sharpen: sharpen,
                    enhance_contrast: contrast,
                }),
            });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Enhancement failed.");
            }

            await updateCanvasImage(data.result_url, data.result_filename);
            showAlert(`Image enhanced successfully at ${scale}x resolution!`, "success");

            if (typeof confetti === "function") {
                confetti({ particleCount: 45, spread: 75, origin: { y: 0.6 } });
            }
        } catch (err) {
            console.error(err);
            showAlert(err.message || "Enhancement failed.");
        } finally {
            setLoading(false);
        }
    }

    // Helper: update background image on canvas smoothly
    async function updateCanvasImage(newUrl, newFilename) {
        state.uploadedFilename = newFilename;
        state.resultUrl = newUrl;
        state.resultFilename = newFilename;

        const newImg = await loadImageElement(newUrl);
        state.originalImageEl = newImg;

        const canvas = state.fabricCanvas;
        if (!canvas || !state.fabricImage) return;

        const baseDisplayWidth = state.fabricImage.getScaledWidth();
        const baseDisplayHeight = state.fabricImage.getScaledHeight();

        return new Promise((resolve) => {
            state.fabricImage.setSrc(newUrl, () => {
                state.fabricImage.set({
                    scaleX: baseDisplayWidth / newImg.width,
                    scaleY: baseDisplayHeight / newImg.height,
                });
                state.originalImageUrl = newUrl;

                // Remove existing drawn masks
                const maskObjects = canvas.getObjects().filter((o) => o !== state.fabricImage);
                maskObjects.forEach((o) => canvas.remove(o));

                if (el.detectedObjectsLayer) {
                    el.detectedObjectsLayer.innerHTML = "";
                    el.detectedObjectsLayer.classList.add("d-none");
                }
                if (el.detectedCountPill) {
                    el.detectedCountPill.classList.add("d-none");
                }

                updateHistoryButtons();
                canvas.renderAll();
                resolve();
            });
        });
    }

    // ---------------------------------------------------------------------
    // Feature 6: Batch Processing
    // ---------------------------------------------------------------------
    let batchFilesQueue = [];

    function initBatchProcessing() {
        if (el.singleModeTab && el.batchModeTab) {
            el.singleModeTab.addEventListener("click", () => {
                el.singleModeTab.classList.add("active-tab-btn");
                el.singleModeTab.classList.remove("text-secondary");
                el.batchModeTab.classList.remove("active-tab-btn");
                el.batchModeTab.classList.add("text-secondary");
                el.dropZoneContainer.classList.remove("d-none");
                el.batchZoneContainer.classList.add("d-none");
            });

            el.batchModeTab.addEventListener("click", () => {
                el.batchModeTab.classList.add("active-tab-btn");
                el.batchModeTab.classList.remove("text-secondary");
                el.singleModeTab.classList.remove("active-tab-btn");
                el.singleModeTab.classList.add("text-secondary");
                el.batchZoneContainer.classList.remove("d-none");
                el.dropZoneContainer.classList.add("d-none");
            });
        }

        if (el.batchBrowseBtn && el.batchFileInput) {
            el.batchBrowseBtn.addEventListener("click", () => el.batchFileInput.click());
            el.batchFileInput.addEventListener("change", () => {
                if (el.batchFileInput.files.length) {
                    addFilesToBatchQueue(Array.from(el.batchFileInput.files));
                }
            });
        }

        if (el.batchDropZone) {
            ["dragenter", "dragover"].forEach((evt) => {
                el.batchDropZone.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    el.batchDropZone.classList.add("drag-over");
                });
            });

            ["dragleave", "drop"].forEach((evt) => {
                el.batchDropZone.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    el.batchDropZone.classList.remove("drag-over");
                });
            });

            el.batchDropZone.addEventListener("drop", (e) => {
                const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
                if (files.length) addFilesToBatchQueue(files);
            });
        }

        if (el.clearBatchBtn) {
            el.clearBatchBtn.addEventListener("click", () => {
                batchFilesQueue = [];
                renderBatchQueue();
            });
        }

        if (el.startBatchProcessBtn) {
            el.startBatchProcessBtn.addEventListener("click", processBatchQueue);
        }
    }

    function addFilesToBatchQueue(newFiles) {
        batchFilesQueue = [...batchFilesQueue, ...newFiles].slice(0, 20); // max 20
        renderBatchQueue();
    }

    function renderBatchQueue() {
        if (!el.batchQueueWrapper || !el.batchItemsList) return;

        if (!batchFilesQueue.length) {
            el.batchQueueWrapper.classList.add("d-none");
            return;
        }

        el.batchQueueWrapper.classList.remove("d-none");
        el.batchCountBadge.textContent = `${batchFilesQueue.length} files queued`;
        el.batchItemsList.innerHTML = "";

        batchFilesQueue.forEach((file, idx) => {
            const item = document.createElement("div");
            item.className = "d-flex justify-content-between align-items-center p-2 rounded-3 bg-white border small";
            item.innerHTML = `
                <div class="d-flex align-items-center gap-2 text-truncate" style="max-width: 75%;">
                    <i class="bi bi-file-earmark-image text-primary"></i>
                    <span class="text-truncate fw-medium">${file.name}</span>
                </div>
                <span class="text-muted">${Math.round(file.size / 1024)} KB</span>
            `;
            el.batchItemsList.appendChild(item);
        });

        if (el.downloadBatchZipBtn) {
            el.downloadBatchZipBtn.classList.add("d-none");
        }
    }

    async function processBatchQueue() {
        if (!batchFilesQueue.length) return;

        const operation = el.batchOperationSelect ? el.batchOperationSelect.value : "remove_background";
        const formData = new FormData();
        batchFilesQueue.forEach((file) => formData.append("images", file));
        formData.append("operation", operation);

        if (el.batchProgressWrapper) el.batchProgressWrapper.classList.remove("d-none");
        if (el.batchProgressBar) el.batchProgressBar.style.width = "40%";
        if (el.startBatchProcessBtn) el.startBatchProcessBtn.disabled = true;

        try {
            const response = await fetch("/api/batch-process", { method: "POST", body: formData });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Batch processing failed.");
            }

            if (el.batchProgressBar) el.batchProgressBar.style.width = "100%";
            showAlert(`Batch complete! Processed ${data.count} images.`, "success");

            if (el.downloadBatchZipBtn) {
                el.downloadBatchZipBtn.classList.remove("d-none");
                el.downloadBatchZipBtn.onclick = () => {
                    window.location.href = data.zip_url;
                };
            }

            if (typeof confetti === "function") {
                confetti({ particleCount: 50, spread: 80, origin: { y: 0.6 } });
            }
        } catch (err) {
            console.error(err);
            showAlert(err.message || "Batch process failed.");
        } finally {
            if (el.startBatchProcessBtn) el.startBatchProcessBtn.disabled = false;
        }
    }

    // ---------------------------------------------------------------------
    // Feature 8: Advanced Comparison Views
    // ---------------------------------------------------------------------
    function initAdvancedComparison() {
        if (el.sliderViewBtn && el.sideBySideViewBtn) {
            el.sliderViewBtn.addEventListener("click", () => {
                el.sliderViewBtn.classList.add("active-tab-btn");
                el.sliderViewBtn.classList.remove("text-secondary");
                el.sideBySideViewBtn.classList.remove("active-tab-btn");
                el.sideBySideViewBtn.classList.add("text-secondary");
                if (el.sliderViewWrapper) el.sliderViewWrapper.classList.remove("d-none");
                if (el.sideBySideWrapper) el.sideBySideWrapper.classList.add("d-none");
            });

            el.sideBySideViewBtn.addEventListener("click", () => {
                el.sideBySideViewBtn.classList.add("active-tab-btn");
                el.sideBySideViewBtn.classList.remove("text-secondary");
                el.sliderViewBtn.classList.remove("active-tab-btn");
                el.sliderViewBtn.classList.add("text-secondary");
                if (el.sideBySideWrapper) el.sideBySideWrapper.classList.remove("d-none");
                if (el.sliderViewWrapper) el.sliderViewWrapper.classList.add("d-none");
            });
        }
    }

    // ---------------------------------------------------------------------
    // Features 7 & 10: Usage Dashboard & Edit History
    // ---------------------------------------------------------------------
    function initUsageDashboardAndHistory() {
        // Dashboard
        if (el.statsModalBtn) {
            el.statsModalBtn.addEventListener("click", async () => {
                const statsModalEl = document.getElementById("statsModal");
                if (statsModalEl && window.bootstrap) {
                    const modal = new bootstrap.Modal(statsModalEl);
                    modal.show();
                    await loadUsageStats();
                }
            });
        }

        // History Drawer
        if (el.historyDrawerBtn) {
            el.historyDrawerBtn.addEventListener("click", async () => {
                const historyDrawerEl = document.getElementById("historyDrawer");
                if (historyDrawerEl && window.bootstrap) {
                    const drawer = new bootstrap.Offcanvas(historyDrawerEl);
                    drawer.show();
                    await loadEditHistory();
                }
            });
        }
    }

    async function loadUsageStats() {
        try {
            const res = await fetch("/api/stats");
            const data = await res.json();
            if (!data.success) return;
            const stats = data.stats;

            const setText = (id, val) => {
                const node = document.getElementById(id);
                if (node) node.textContent = val;
            };

            setText("statTotalProcessed", stats.total_processed || 0);
            setText("statObjectsRemoved", stats.objects_removed || 0);
            setText("statBgRemoved", stats.backgrounds_removed || 0);
            setText("statAvgLatency", `${stats.avg_processing_time || 0}s`);

            setText("statBreakdownInpaint", stats.objects_removed || 0);
            setText("statBreakdownBg", stats.backgrounds_removed || 0);
            setText("statBreakdownDetect", stats.objects_detected || 0);
            setText("statBreakdownEnhance", stats.images_enhanced || 0);

            setText("statLastUpdated", stats.last_updated || "Just now");
        } catch (e) {
            console.error("Failed to load stats:", e);
        }
    }

    async function loadEditHistory() {
        if (!el.historyListContainer) return;
        try {
            const res = await fetch("/api/history?limit=25");
            const data = await res.json();
            if (!data.success || !data.history.length) {
                el.historyListContainer.innerHTML = `
                    <div class="text-center py-5 text-muted small">
                        <i class="bi bi-inbox fs-2 d-block mb-2 text-secondary"></i>
                        No edit history recorded yet.
                    </div>
                `;
                return;
            }

            el.historyListContainer.innerHTML = "";
            data.history.forEach((item) => {
                const card = document.createElement("div");
                card.className = "history-item-card d-flex align-items-center justify-content-between gap-2";
                card.innerHTML = `
                    <div class="d-flex align-items-center gap-3 text-truncate">
                        <img src="${item.result_url}" alt="Thumbnail" class="rounded-2" style="width: 48px; height: 48px; object-fit: cover;">
                        <div class="text-truncate">
                            <span class="d-block fw-bold small text-dark text-truncate text-capitalize">${item.action.replace(/_/g, ' ')}</span>
                            <span class="text-muted extra-small" style="font-size: 0.72rem;">${item.formatted_time || ''}</span>
                        </div>
                    </div>
                    <div class="d-flex gap-1">
                        <button class="btn btn-sm btn-outline-primary rounded-pill px-2 py-1 restore-history-btn" title="Reopen in Studio">
                            <i class="bi bi-pencil"></i>
                        </button>
                        <a href="${item.result_url}" download="${item.result_filename}" class="btn btn-sm btn-outline-secondary rounded-pill px-2 py-1" title="Download">
                            <i class="bi bi-download"></i>
                        </a>
                    </div>
                `;

                const restoreBtn = card.querySelector(".restore-history-btn");
                if (restoreBtn) {
                    restoreBtn.addEventListener("click", async () => {
                        const historyDrawerEl = document.getElementById("historyDrawer");
                        if (historyDrawerEl && window.bootstrap) {
                            const inst = bootstrap.Offcanvas.getInstance(historyDrawerEl);
                            if (inst) inst.hide();
                        }
                        setLoading(true, "Restoring previous project...");
                        state.uploadedFilename = item.result_filename;
                        state.resultFilename = item.result_filename;
                        state.resultUrl = item.result_url;
                        state.initialImageUrl = item.original_url;
                        state.originalImageUrl = item.result_url;
                        await initEditor(item.result_url);
                        showSection("editor");
                        setLoading(false);
                    });
                }

                el.historyListContainer.appendChild(card);
            });
        } catch (e) {
            console.error("Failed to load history:", e);
        }
    }
    function initExtraDelightFeatures() {
        // 1. Click to try sample images
        document.querySelectorAll("[data-sample]").forEach((card) => {
            const clickHandler = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const sampleUrl = card.getAttribute("data-sample");
                const sampleAction = card.getAttribute("data-action");
                if (!sampleUrl) return;

                try {
                    setLoading(true, "Loading playground sample...");
                    showSection("editor");
                    const res = await fetch(sampleUrl);
                    if (!res.ok) throw new Error("Failed to fetch sample image.");
                    const blob = await res.blob();
                    const filename = sampleUrl.split("/").pop() || "sample.png";
                    const file = new File([blob], filename, { type: blob.type || "image/png" });
                    await handleFile(file);

                    // Suggested sample action
                    if (sampleAction === "detect") {
                        setTimeout(() => runObjectDetection(), 800);
                    }
                } catch (err) {
                    console.error("Error loading sample image:", err);
                    showAlert("Could not load sample image. Please try uploading a photo.");
                    setLoading(false);
                    showSection("upload");
                }
            };

            card.addEventListener("click", clickHandler);
            card.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    clickHandler(e);
                }
            });
        });

        // 2. Clipboard Paste (Ctrl+V) anywhere
        window.addEventListener("paste", (e) => {
            if (e.clipboardData && e.clipboardData.items) {
                for (let i = 0; i < e.clipboardData.items.length; i++) {
                    const item = e.clipboardData.items[i];
                    if (item.type.indexOf("image") !== -1) {
                        const blob = item.getAsFile();
                        if (blob) {
                            const file = new File([blob], `pasted_image_${Date.now()}.png`, { type: blob.type });
                            handleFile(file);
                            break;
                        }
                    }
                }
            }
        });

        // 3. Shortcuts modal trigger
        const shortcutsBtn = document.getElementById("shortcutsModalBtn");
        const shortcutsModalEl = document.getElementById("shortcutsModal");
        if (shortcutsBtn && shortcutsModalEl && window.bootstrap) {
            const modal = new bootstrap.Modal(shortcutsModalEl);
            shortcutsBtn.addEventListener("click", () => modal.show());
        }

        // 4. Keyboard shortcuts (B for brush, L for lasso, [ and ] for brush size)
        document.addEventListener("keydown", (e) => {
            if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
            if (el.editorSection.classList.contains("d-none")) return;

            if (e.key.toLowerCase() === "b" && !e.ctrlKey && !e.metaKey) {
                setTool("brush");
            } else if (e.key.toLowerCase() === "l" && !e.ctrlKey && !e.metaKey) {
                setTool("lasso");
            } else if (e.key === "[") {
                const newSize = Math.max(5, state.brushSize - 10);
                el.brushSize.value = newSize;
                el.brushSize.dispatchEvent(new Event("input"));
            } else if (e.key === "]") {
                const newSize = Math.min(300, state.brushSize + 10);
                el.brushSize.value = newSize;
                el.brushSize.dispatchEvent(new Event("input"));
            }
        });
    }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------
    function init() {
        initUploadHandlers();
        initToolbarHandlers();
        initCompareSlider();
        initResultHandlers();
        initExtraDelightFeatures();
        initBatchProcessing();
        initAdvancedComparison();
        initUsageDashboardAndHistory();

        if (el.smartDetectBtn) el.smartDetectBtn.addEventListener("click", runObjectDetection);
        if (el.removeBgBtn) el.removeBgBtn.addEventListener("click", runBackgroundRemoval);
        if (el.applyEnhanceBtn) el.applyEnhanceBtn.addEventListener("click", runImageEnhancement);
    }

    window.addEventListener("DOMContentLoaded", init);
})();
