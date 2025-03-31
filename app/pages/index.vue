<script setup lang="ts">
const streamPreview = ref<string>('');

onMounted(() => {
  setInterval(async () => {
    const res = await $fetch('/api/stream')
    console.log(res)
    streamPreview.value = res;
  },  1000) // 30 fps
})



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
  <div class="w-full h-svh bg-black/5 bg-cover bg-no-repeat" :style="{ backgroundImage: `url('data:image/png;base64,${streamPreview}')` }"  @click="onTriggerCountdown"></div>
  <div v-if="showCountdown" class="flex justify-center items-center h-svh w-full absolute top-0 left-0 bg-black/10">
    <div class="flex gap-2 items-center">
      <div class="text-[20rem] font-bold text-black">
        {{ countdown }}
      </div>
    </div>
  </div>
</template>