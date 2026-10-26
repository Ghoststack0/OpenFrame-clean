#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  void *library = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
  if (!library) { fprintf(stderr, "%s\n", dlerror()); return 3; }
  int (*init)(const char *) = dlsym(library, "vips_init");
  const char *(*find)(const void *, size_t) = dlsym(library, "vips_foreign_find_load_buffer");
  if (!init || !find || init("loader-probe")) return 4;
  FILE *file = fopen(argv[2], "rb");
  if (!file || fseek(file, 0, SEEK_END)) return 5;
  long length = ftell(file);
  if (length <= 0 || fseek(file, 0, SEEK_SET)) return 5;
  void *bytes = malloc((size_t) length);
  if (!bytes || fread(bytes, 1, (size_t) length, file) != (size_t) length) return 6;
  fclose(file);
  const char *loader = find(bytes, (size_t) length);
  if (!loader) return 7;
  puts(loader);
  void *(*image_from_buffer)(const void *, size_t, const char *, ...) = dlsym(library, "vips_image_new_from_buffer");
  int (*get_string)(const void *, const char *, const char **) = dlsym(library, "vips_image_get_string");
  void (*unref)(void *) = dlsym(library, "g_object_unref");
  if (!image_from_buffer || !get_string || !unref) return 8;
  void *image = image_from_buffer(bytes, (size_t) length, "", NULL);
  if (!image) return 9;
  const char *format = NULL;
  if (!get_string(image, "magick-format", &format)) printf("magick-format=%s\n", format);
  unref(image);
  free(bytes);
  return 0;
}
