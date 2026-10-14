// kay's entry into libavif: an 8-bit RGBA image to an AVIF, with the settings @jsquash/avif 2.1.1 encoded kay's variants with (4:2:0, BT.601, sharpness and denoise 0, tune=ssim), so a newer libaom writes within about 1% of its bytes.
#include <stdint.h>
#include <emscripten/emscripten.h>
#include "avif/avif.h"

// The last encode's output, kept until the next call so JS can copy it out; one encode runs at a time in a worker.
static avifRWData output = AVIF_DATA_EMPTY;
static avifResult status = AVIF_RESULT_OK;

EMSCRIPTEN_KEEPALIVE size_t kay_avif_encode(const uint8_t *rgba, int width, int height, int quality, int speed) {
  avifRWDataFree(&output);
  status = AVIF_RESULT_OUT_OF_MEMORY;

  avifImage *image = avifImageCreate(width, height, 8, AVIF_PIXEL_FORMAT_YUV420);
  avifEncoder *encoder = avifEncoderCreate();

  if (image == NULL || encoder == NULL)
    goto done;

  image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;

  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, image);
  rgb.pixels = (uint8_t *)rgba;
  rgb.rowBytes = width * 4;

  if ((status = avifImageRGBToYUV(image, &rgb)) != AVIF_RESULT_OK)
    goto done;

  encoder->quality = quality;
  encoder->qualityAlpha = quality;
  encoder->speed = speed;

  if ((status = avifEncoderSetCodecSpecificOption(encoder, "sharpness", "0")) != AVIF_RESULT_OK)
    goto done;

  // libavif 1.0 tuned for SSIM whenever left unset, at every quality and for alpha too; 1.4 picks tune IQ for colour instead, which writes other bytes.
  if ((status = avifEncoderSetCodecSpecificOption(encoder, "tune", "ssim")) != AVIF_RESULT_OK)
    goto done;

  if ((status = avifEncoderSetCodecSpecificOption(encoder, "color:denoise-noise-level", "0")) != AVIF_RESULT_OK)
    goto done;

  status = avifEncoderWrite(encoder, image, &output);

done:
  if (encoder != NULL)
    avifEncoderDestroy(encoder);

  if (image != NULL)
    avifImageDestroy(image);

  return status == AVIF_RESULT_OK ? output.size : 0;
}

EMSCRIPTEN_KEEPALIVE const uint8_t *kay_avif_output(void) {
  return output.data;
}

EMSCRIPTEN_KEEPALIVE const char *kay_avif_error(void) {
  return avifResultToString(status);
}
