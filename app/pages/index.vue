<script setup lang="ts">
import { useIntervalFn, useTimeoutFn, useWebSocket } from '@vueuse/core';

const canvasRef = ref<HTMLCanvasElement | null>(null);

const drawFrame = (bitmap: ImageBitmap) => {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) {
    bitmap.close();
    return;
  }

  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;
  const imageWidth = bitmap.width;
  const imageHeight = bitmap.height;

  const canvasAspect = canvasWidth / canvasHeight;
  const imageAspect = imageWidth / imageHeight;

  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = imageWidth;
  let sourceHeight = imageHeight;

  // Draw as "cover" so framing matches previous object-cover behavior.
  if (imageAspect > canvasAspect) {
    sourceWidth = imageHeight * canvasAspect;
    sourceX = (imageWidth - sourceWidth) / 2;
  } else {
    sourceHeight = imageWidth / canvasAspect;
    sourceY = (imageHeight - sourceHeight) / 2;
  }

  ctx.drawImage(
    bitmap,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvasWidth,
    canvasHeight
  );
  bitmap.close();
};


const liveViewUrl = computed(() => {
  if (!import.meta.client) {
    return '';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/liveview`;
});

const { open: openLiveView, close: closeLiveView } = useWebSocket(liveViewUrl, {
  immediate: false,
  autoReconnect: {
    retries: Number.POSITIVE_INFINITY,
    delay: 500
  },
  onConnected(socket) {
    socket.binaryType = 'arraybuffer';
  },
  onMessage(_, event) {
    if (typeof event.data === 'string') {
      try {
        const payload = JSON.parse(event.data) as {
          type: string;
          message?: string;
        };
        if (payload.type === 'error') {
          console.error('Liveview websocket server error:', payload.message);
        }
      } catch (error) {
        console.error('Error parsing liveview websocket payload:', error);
      }
      return;
    }

    const frameBuffer = event.data as ArrayBuffer;
    createImageBitmap(
      new Blob([frameBuffer], { type: 'image/jpeg' })
    ).then((bitmap) => {
      requestAnimationFrame(() => {
        drawFrame(bitmap);
      });
    }).catch((error) => {
      console.error('Failed to decode liveview frame:', error);
    });
  },
  onError(_, error) {
    console.error('Liveview websocket error:', error);
  }
});

onMounted(async () => {
  await nextTick();
  const canvas = canvasRef.value;
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
    canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
  }
  openLiveView();
});

onUnmounted(() => {
  closeLiveView();
});

const showCountdown = ref(false)
const countdown = ref(0)
const takingPicture = ref(false)

const { pause: pauseCountdown, resume: startCountdown } = useIntervalFn(() => {
  if (countdown.value === 1) {
    pauseCountdown();
    onCapture();
    return;
  }
  countdown.value--;
}, 1000, { immediate: false });

const { start: startPreviewTimeout, stop: stopPreviewTimeout } = useTimeoutFn(() => {
  takingPicture.value = false;
  finalImage.value = undefined;
}, 5000, { immediate: false });

const finalImage = ref<string | undefined>();

const onTriggerCountdown = () => {
  if (takingPicture.value) return

  takingPicture.value = true
  showCountdown.value = true
  countdown.value = 5
  startCountdown();
}

const onCapture = async () => {
  showCountdown.value = false
  pauseCountdown();
  finalImage.value = `data:image/jpeg;base64,${await $fetch('/api/capture')}`;

  stopPreviewTimeout();
  startPreviewTimeout();
}
</script>

<template>
  <div class="relative w-full h-svh bg-black/5" @mousedown="onTriggerCountdown">
    <canvas ref="canvasRef" class="w-full h-svh object-cover" />
    <img v-if="finalImage" :src="finalImage" class="absolute inset-0 w-full h-svh object-cover" />
    <img src="/qr-code.svg" class="absolute left-0 bottom-0 w-64">
    <div v-if="showCountdown || (takingPicture && finalImage == undefined)"
      class="flex justify-center items-center h-svh w-full absolute top-0 left-0 bg-black/20">
      <div class="flex gap-2 items-center w-full h-full justify-center">
        <div class="text-[20rem] font-bold text-white flex items-center justify-center">
          <transition name="scale">
            <span v-if="showCountdown" :key="countdown"
              class="inline-block absolute transform transition-transform duration-300">{{ countdown }}</span>
          </transition>
          <span v-if="!showCountdown && finalImage == undefined">
            <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              class="lucide lucide-loader-circle-icon lucide-loader-circle animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scale-enter-active,
.scale-leave-active {
  transition: transform 0.3s ease;
}

.scale-enter-from,
.scale-leave-to {
  transform: scale(0.5);
  opacity: 0;
}

.scale-enter-to,
.scale-leave-from {
  transform: scale(1);
  opacity: 1;
}
</style>