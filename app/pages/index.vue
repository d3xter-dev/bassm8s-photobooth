<script setup lang="ts">
const streamPreview = ref<string>('');

onMounted(() => {
  setInterval(async () => {
    streamPreview.value = await $fetch('/api/stream');
  }, 30 / 1000) // 30 fps
})



const showCountdown = ref(false)
const countdown = ref(0)

const onTriggerCountdown = () => {
  showCountdown.value = true
  countdown.value = 5
}

setInterval(() => {
  if (countdown.value > 0) {
    countdown.value--
  }
}, 1000)
</script>

<template>
  <div class="w-full h-svh bg-black/5" :style="{ backgroundImage: `url(${streamPreview})` }"  @click="onTriggerCountdown"></div>
  <div v-if="showCountdown" class="flex justify-center items-center h-svh w-full absolute top-0 left-0">
    <div class="flex gap-2 items-center">
      <div class="text-3xl font-bold text-black">
        {{ countdown }}
      </div>
    </div>
  </div>
</template>

<style scoped>

</style>