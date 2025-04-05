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
    showCountdown.value = false
  }, 5000) // show picture for 5 seconds
}
</script>

<template>
  <div class="relative w-full h-svh bg-black/5">
    <img 
      v-if="imageData" 
      :src="finalImage ? finalImage : imageData"
      class="w-full h-svh object-cover"
      @mousedown="onTriggerCountdown"
    />
    <div v-if="showCountdown" class="flex justify-center items-center h-svh w-full absolute top-0 left-0 bg-black/10">
      <div class="flex gap-2 items-center">
        <div class="text-[20rem] font-bold text-black">
          {{ countdown }}
        </div>
      </div>
    </div>
  </div>
</template>