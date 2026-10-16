<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted } from "vue";
import { useShellStore } from "../stores/shell";

/**
 * 浮层生命周期（不渲染 DOM）：Esc 只关最上面那一层，与既有产品的层序一致。
 * 每个浮层自己的遮罩（.cc-shade / .search-shade / .quicklook）由各自组件渲染 ——
 * 这里不再自造一层 .scrim，那是上一轮自创的、既有产品里没有的东西。
 */
export default defineComponent({
  name: "Overlays",
  setup() {
    const shell = useShellStore();

    function onKeydown(event: KeyboardEvent) {
      // ⌘K / Ctrl+K：开关全局搜索（10-15 按原型补齐，与顶栏"显示"菜单里标注的快捷键一致）
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        shell.toggleSearch();
        return;
      }
      // ⌥空格：开关助理浮层（设计语言 §5.3 的唤起方式）
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === "Space") {
        event.preventDefault();
        shell.toggleAI();
        return;
      }
      if (event.key !== "Escape" || !shell.anyOverlay) return;
      event.preventDefault();
      shell.closeTopOverlay();
    }

    onMounted(() => window.addEventListener("keydown", onKeydown));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

    return () => null;
  },
});
</script>
