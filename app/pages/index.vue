<script setup lang="ts">
const streamPreview = ref<string>('');
const imageData = ref('');

// Fetch stream data on regular intervals
onMounted(() => {
  fetchStreamData();
});

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

const showCountdown = ref(false)
const countdown = ref(0)

const onTriggerCountdown = () => {
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

const onCapture = () => {
  showCountdown.value = false
  $fetch('/api/capture')
}
</script>

<template>
  <div class="relative w-full h-svh bg-black/5">
    <img 
      v-if="imageData" 
      :src="imageData" 
      class="w-full h-svh object-cover"
      @click="onTriggerCountdown"
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