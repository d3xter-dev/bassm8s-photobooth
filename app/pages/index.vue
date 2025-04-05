<script setup lang="ts">
const imageData = ref('');

// Fetch stream data on regular intervals
const fetchStreamData = () => {
  $fetch('/api/stream')
    .then((data) => {
      if (data) {
        imageData.value = `data:image/jpeg;base64,${data}`;
      }
      // Continue polling
      setTimeout(fetchStreamData, 24 / 1000);
    })
    .catch(error => {
      console.error('Error fetching stream data:', error);
      // Retry after a delay
      setTimeout(fetchStreamData, 1000);
    });
};
onMounted(fetchStreamData);

const showCountdown = ref(false)
const countdown = ref(0)
const takingPicture = ref(false)

const onTriggerCountdown = () => {
  if(takingPicture.value) return

  takingPicture.value = true
  showCountdown.value = true
  countdown.value = 5

  const interval = setInterval(() => {
    if (countdown.value == 1) {
      clearInterval(interval)
      onCapture()
      return
    }

    countdown.value--
  }, 1000)
}

const finalImage = ref<string|undefined>();
const onCapture = async () => {
  showCountdown.value = false
  finalImage.value = `data:image/jpeg;base64,${await $fetch('/api/capture')}`;

  console.log(finalImage.value)

  setTimeout(() => {
    takingPicture.value = false
    finalImage.value = undefined
  }, 5000) // show picture for 5 seconds
}
</script>

<template>
  <div class="relative w-full h-svh bg-black/5"  @mousedown="onTriggerCountdown">
    <img 
      v-if="imageData" 
      :src="finalImage ? finalImage : imageData"
      class="w-full h-svh object-cover"
    />
    <img src="/qr-code.svg" class="absolute left-0 bottom-0 w-64">
    <div v-if="showCountdown || (takingPicture && finalImage == undefined)" class="flex justify-center items-center h-svh w-full absolute top-0 left-0 bg-black/20">
      <div class="flex gap-2 items-center w-full h-full justify-center">
        <div class="text-[20rem] font-bold text-white flex items-center justify-center">
          <transition name="scale">
            <span v-if="showCountdown" :key="countdown" class="inline-block absolute transform transition-transform duration-300">{{ countdown }}</span>
          </transition>
          <span v-if="!showCountdown && finalImage == undefined">
            <svg xmlns="http://www.w3.org/2000/svg"  width="128" height="128" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle-icon lucide-loader-circle animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
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