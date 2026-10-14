# Usage: perl -0pi x86-emscripten.pl aom_ports/x86.h
# libaom's x86 helpers use GCC inline asm with x86 register constraints (cpuid, xgetbv, rdtsc, pause), which wasm cannot compile.
# With CONFIG_RUNTIME_CPU_DETECT=0 none of them runs, so each becomes a zero-returning stand-in.
s/__asm__ __volatile__\("rdtsc\\n\\t" : "=a"\(tsc\) :\);/tsc = 0;/;
s/__asm__ __volatile__\("rdtsc" : "=a"\(lo\), "=d"\(hi\)\);/lo = hi = 0;/;
s/__asm__ __volatile__\("rdtscp\\n\\t" : "=a"\(tscp\) :\);/tscp = 0;/;
s/#define x86_pause_hint\(\) __asm__ __volatile__\("pause \\n\\t"\)/#define x86_pause_hint() ((void)0)/;
s/__asm__ volatile\("\.byte 0x0f, 0x01, 0xd0\\n"\s*: "=a"\(eax\), "=d"\(edx\)\s*: "c"\(ecx\)\);/eax = edx = 0; (void)ecx;/;
s|(// NaCl has no support for xgetbv)|#if defined(__EMSCRIPTEN__)\n#undef cpuid\n#define cpuid(func, func2, a, b, c, d) do { a = b = c = d = 0; (void)(func); (void)(func2); } while (0)\n#endif\n\n$1|;
s/__asm__ __volatile__\("fldcw %0" : : "m"\(\*&mode\)\);/(void)mode;/;
s/__asm__ __volatile__\("fstcw %0\\n\\t" : "=m"\(\*&mode\) :\);/mode = 0x27f;/;
