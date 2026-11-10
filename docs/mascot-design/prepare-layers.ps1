param([string]$Source, [string]$Destination)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class MascotAlpha {
  public static void Convert(string source, string destination) {
    using(var input = new Bitmap(source))
    using(var bmp = new Bitmap(input.Width,input.Height,PixelFormat.Format32bppArgb)) {
      using(var g=Graphics.FromImage(bmp)) g.DrawImageUnscaled(input,0,0);
      int w=bmp.Width,h=bmp.Height;
      var rect=new Rectangle(0,0,w,h);
      var data=bmp.LockBits(rect,ImageLockMode.ReadWrite,PixelFormat.Format32bppArgb);
      var pixels=new byte[data.Stride*h]; Marshal.Copy(data.Scan0,pixels,0,pixels.Length);
      var seen=new bool[w*h]; var queue=new Queue<int>();
      Action<int> add = i => { if(seen[i])return; int p=(i/w)*data.Stride+(i%w)*4;
        int hi=Math.Max(pixels[p],Math.Max(pixels[p+1],pixels[p+2]));
        int lo=Math.Min(pixels[p],Math.Min(pixels[p+1],pixels[p+2]));
        if(hi-lo>15)return; seen[i]=true;queue.Enqueue(i); };
      for(int x=0;x<w;x++){add(x);add((h-1)*w+x);}
      for(int y=0;y<h;y++){add(y*w);add(y*w+w-1);}
      // Transparent gap enclosed by the two left-side hair strands in this design.
      if(w==1254 && h==1254)add(550*w+133);
      while(queue.Count>0){int i=queue.Dequeue(),x=i%w,y=i/w;
        if(x>0)add(i-1);if(x<w-1)add(i+1);if(y>0)add(i-w);if(y<h-1)add(i+w);}
      for(int i=0;i<seen.Length;i++)if(seen[i]){int p=(i/w)*data.Stride+(i%w)*4;pixels[p]=pixels[p+1]=pixels[p+2]=pixels[p+3]=0;}
      Marshal.Copy(pixels,0,data.Scan0,pixels.Length);bmp.UnlockBits(data);
      bmp.Save(destination,ImageFormat.Png);
    }
  }
}
'@
[MascotAlpha]::Convert($Source, $Destination)

