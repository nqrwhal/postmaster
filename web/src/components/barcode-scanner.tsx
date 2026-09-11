import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { barcodeErrorMessage, normalizeTrackingValue } from "../lib/barcode";

export interface BarcodeScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
}

const formats = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.PDF_417,
  BarcodeFormat.QR_CODE,
];

const hints = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, formats],
  [DecodeHintType.TRY_HARDER, true],
]);

// Live frames usually contain a horizontal shipping barcode. Avoid expensive
// 2D/rotation searches on every frame, but keep them as a periodic fallback.
const liveHints = new Map<DecodeHintType, unknown>([
  [
    DecodeHintType.POSSIBLE_FORMATS,
    [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF],
  ],
]);

class LiveShippingReader extends BrowserMultiFormatReader {
  private attempts = 0;
  private rotatedCanvas: HTMLCanvasElement | null = null;

  constructor() {
    super(liveHints, {
      delayBetweenScanAttempts: 100,
      delayBetweenScanSuccess: 100,
    });
  }

  override decodeFromCanvas(canvas: HTMLCanvasElement) {
    const thorough = ++this.attempts % 4 === 0;
    this.setHints(thorough ? hints : liveHints);
    try {
      return super.decodeFromCanvas(canvas);
    } catch (error) {
      if (!thorough) throw error;
      // ZXing's built-in rotation retains the original source dimensions.
      // Rotate into a correctly sized canvas for vertical shipping labels.
      const rotated = (this.rotatedCanvas ??= document.createElement("canvas"));
      rotated.width = canvas.height;
      rotated.height = canvas.width;
      const context = rotated.getContext("2d", { willReadFrequently: true });
      if (!context) throw error;
      context.translate(0, canvas.width);
      context.rotate(-Math.PI / 2);
      context.drawImage(canvas, 0, 0);
      return super.decodeFromCanvas(rotated);
    }
  }
}

export function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runRef = useRef(0);
  const [state, setState] = useState<
    "idle" | "starting" | "scanning" | "reading"
  >("idle");
  const [error, setError] = useState("");

  const stop = useCallback(() => {
    runRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    readerRef.current = null;
  }, []);

  const finish = useCallback(
    (raw: string) => {
      try {
        const value = normalizeTrackingValue(raw);
        stop();
        onScan(value);
      } catch (cause) {
        stop();
        setState("idle");
        setError(barcodeErrorMessage(cause));
      }
    },
    [onScan, stop],
  );

  const start = useCallback(async () => {
    stop();
    setError("");
    setState("starting");
    const run = runRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Camera media devices are not supported");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (run !== runRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const reader = new LiveShippingReader();
      readerRef.current = reader;
      const controls = await reader.decodeFromStream(
        stream,
        videoRef.current ?? undefined,
        (result, _decodeError, callbackControls) => {
          if (run !== runRef.current) return;
          if (!result) return;
          try {
            const value = normalizeTrackingValue(result.getText());
            callbackControls.stop();
            if (run !== runRef.current) return;
            stop();
            onScan(value);
          } catch (cause) {
            stop();
            setState("idle");
            setError(barcodeErrorMessage(cause));
          }
        },
      );
      if (run !== runRef.current) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
      setState("scanning");
    } catch (cause) {
      if (run !== runRef.current) return;
      stop();
      setState("idle");
      setError(barcodeErrorMessage(cause));
    }
  }, [onScan, stop]);

  const readPhoto = useCallback(
    async (file: File) => {
      stop();
      setError("");
      setState("reading");
      const run = runRef.current;
      const url = URL.createObjectURL(file);
      try {
        const reader = new BrowserMultiFormatReader(hints);
        readerRef.current = reader;
        const result = await reader.decodeFromImageUrl(url);
        if (run === runRef.current) finish(result.getText());
      } catch (cause) {
        if (run === runRef.current) {
          setState("idle");
          setError(barcodeErrorMessage(cause));
        }
      } finally {
        URL.revokeObjectURL(url);
        readerRef.current = null;
      }
    },
    [finish, stop],
  );

  useEffect(() => stop, [stop]);

  return (
    <section className="scanner">
      <div className="scanner-preview">
        <video
          ref={videoRef}
          className="scanner-video"
          autoPlay
          muted
          playsInline
          aria-label="Camera barcode preview"
        />
        {state === "idle" && <p>Start the camera or select a barcode photo.</p>}
      </div>
      <div className="scanner-actions">
        <button
          type="button"
          onClick={start}
          disabled={state === "starting" || state === "reading"}
        >
          {state === "starting"
            ? "Starting camera…"
            : state === "scanning"
              ? "Restart camera"
              : "Start camera"}
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={state === "starting" || state === "reading"}
        >
          {state === "reading" ? "Reading…" : "Choose photo"}
        </button>
        <input
          ref={inputRef}
          className="scanner-file"
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void readPhoto(file);
          }}
        />
      </div>
      <p className="scanner-help">
        Keep the whole barcode in view. Photos stay on this device.
      </p>
      {error && (
        <p className="scanner-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="scanner-manual"
        onClick={() => {
          stop();
          onClose();
        }}
      >
        Enter manually
      </button>
    </section>
  );
}

export default BarcodeScanner;
