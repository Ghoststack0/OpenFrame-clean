#include <libraw/libraw.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
 if(argc!=3)return 2;
 libraw_data_t *r=libraw_init(LIBRAW_OPIONS_NO_DATAERR_CALLBACK);
 if(!r)return 3;
 int e=libraw_open_file(r,argv[1]);
 if(!e)e=libraw_unpack(r);
 r->rawparams.max_raw_memory_mb=8192;
 r->params.user_flip=0;r->params.output_bps=16;r->params.use_camera_wb=1;
 if(!e)e=libraw_dcraw_process(r);
 libraw_processed_image_t *p=e?NULL:libraw_dcraw_make_mem_image(r,&e);
 if(e||!p){fprintf(stderr,"%s\n",libraw_strerror(e));return 4;}
 fprintf(stderr,"libraw=%s width=%u height=%u colors=%u bits=%u bytes=%u\n",libraw_version(),p->width,p->height,p->colors,p->bits,p->data_size);
 FILE *f=fopen(argv[2],"wb");if(!f)return 5;
 int ok=fwrite(p->data,1,p->data_size,f)==p->data_size;ok &= fclose(f)==0;
 libraw_dcraw_clear_mem(p);libraw_close(r);return ok?0:6;
}
