/* Informe local con texto y tablas nativos; solo los gráficos son imágenes. */
(() => {
  'use strict';
  const svgStyle=`text{font:10px Arial,sans-serif;fill:#7b8996}.axis-label{font-size:9px}.value-label{fill:#073762;font-weight:bold}.count-label{fill:#073762;font-size:9px}.value-label,.count-label{paint-order:stroke fill;stroke:white;stroke-width:3px;stroke-linejoin:round}.hit{fill:transparent}`;

  // Copia todos los tramos antes de esperar: el hover y los cambios de filtros
  // posteriores nunca modifican la figura incluida en el informe.
  function figures(svg,title,note=''){
    if(!svg)return [];
    const copy=svg.cloneNode(true),box=svg.viewBox.baseVal;
    copy.querySelectorAll('.active,.dimmed').forEach(el=>el.classList.remove('active','dimmed'));
    copy.querySelectorAll('title').forEach(el=>el.remove());
    const style=document.createElementNS('http://www.w3.org/2000/svg','style');style.textContent=svgStyle;copy.prepend(style);
    copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.removeAttribute('style');copy.setAttribute('overflow','hidden');
    const starts=[0],hits=[...svg.querySelectorAll('[data-mark] .hit')];
    for(const hit of hits){
      const x=Number(hit.getAttribute('x'));
      if(x-starts.at(-1)>850)starts.push(x-3);
    }
    return starts.map((start,i)=>{
      const width=(starts[i+1]??box.width)-start;
      copy.setAttribute('viewBox',`${start} ${box.y} ${width} ${box.height}`);
      copy.setAttribute('width',String(width));copy.setAttribute('height',String(box.height));
      return {type:'figure',title:title+(starts.length>1?` - tramo ${i+1}/${starts.length}`:''),note,width,height:box.height,svg:new XMLSerializer().serializeToString(copy)};
    });
  }

  async function rasterize(figure){
    const image=new Image();
    image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(figure.svg);
    await image.decode();
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(figure.width*2);canvas.height=Math.ceil(figure.height*2);
    const context=canvas.getContext('2d');
    context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png');
  }

  async function create(report){
    if(!window.PDFLib)throw new Error('No se cargó la biblioteca PDF. Recarga el panel.');
    const {PDFDocument,StandardFonts,rgb}=window.PDFLib;
    const pdf=await PDFDocument.create();
    pdf.setTitle(`Control de combustible - ${report.title}`);pdf.setAuthor('Resiter Minería');pdf.setSubject(report.filters);
    const regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
    const logo=await pdf.embedPng(window.COMBUSTIBLE_PDF_LOGO);
    const navy=rgb(7/255,55/255,98/255),ink=rgb(27/255,42/255,58/255),grey=rgb(.36,.42,.49),border=rgb(.86,.89,.93),light=rgb(.90,.94,.97),white=rgb(1,1,1);
    const pageWidth=841.89,pageHeight=595.28,margin=32,available=pageWidth-2*margin,bottom=37;
    let page,y;
    const safe=value=>Array.from(String(value??'—').replace(/[\u2010-\u2015\u2212]/g,'-').replace(/Σ/g,'Suma').replace(/≥/g,'>=').replace(/≤/g,'<=').replace(/\s+/g,' ').trim()).map(c=>{try{regular.encodeText(c);return c;}catch{return '?';}}).join('');
    function wrap(value,width,size=9,font=regular){
      const words=safe(value).split(' '),lines=[];let line='';
      for(let word of words){
        if(font.widthOfTextAtSize(word,size)>width){
          if(line){lines.push(line);line='';}
          let part='';
          for(const c of word){if(part&&font.widthOfTextAtSize(part+c,size)>width){lines.push(part);part='';}part+=c;}
          word=part;
        }
        if(line&&font.widthOfTextAtSize(line+' '+word,size)>width){lines.push(line);line=word;}
        else line+=(line?' ':'')+word;
      }
      if(line||!lines.length)lines.push(line);return lines;
    }
    function newPage(){
      page=pdf.addPage([pageWidth,pageHeight]);
      const size=logo.scale(Math.min(88/logo.width,47/logo.height));
      page.drawImage(logo,{x:margin,y:pageHeight-23-size.height,width:size.width,height:size.height});
      page.drawText('Control de combustible',{x:margin+107,y:pageHeight-36,size:16,font:bold,color:navy});
      page.drawText(safe(report.title),{x:margin+107,y:pageHeight-53,size:11,font:regular,color:grey});
      page.drawLine({start:{x:margin,y:pageHeight-79},end:{x:pageWidth-margin,y:pageHeight-79},thickness:.7,color:border});
      y=pageHeight-97;
    }
    function ensure(height){if(y-height<bottom)newPage();}
    function paragraph(value,size=9,emphasis=false){
      const font=emphasis?bold:regular;
      for(const line of wrap(value,available,size,font)){ensure(size+5);page.drawText(line,{x:margin,y:y-size,size,font,color:emphasis?navy:grey});y-=size+4;}
      y-=5;
    }
    function heading(value){ensure(65);paragraph(value,11,true);}
    function table(block){
      const weights=block.widths||block.headers.map(()=>1),sum=weights.reduce((a,b)=>a+b,0),widths=weights.map(w=>w/sum*available);
      function row(values,kind='normal',header=false){
        const font=header||['group','total'].includes(kind)?bold:regular,size=header?8:8.5,lineHeight=11;
        const cells=values.map((value,i)=>wrap(value,widths[i]-14,size,font)),height=Math.max(25,...cells.map(lines=>lines.length*lineHeight+12));
        if(y-height<bottom){newPage();paragraph(block.title+' (continuación)',10,true);row(block.headers,'header',true);}
        const dark=kind==='total',fill=header?navy:dark?navy:kind==='group'?light:kind==='unit'?rgb(.96,.97,.98):white;
        page.drawRectangle({x:margin,y:y-height,width:available,height,color:fill});
        let x=margin;
        cells.forEach((lines,i)=>{
          for(let j=0;j<lines.length;j++){
            const text=lines[j],right=!header&&i>0&&!block.textColumns?.includes(i);
            page.drawText(text,{x:right?x+widths[i]-7-font.widthOfTextAtSize(text,size):x+7,y:y-10-size-j*lineHeight,size,font,color:header||dark?white:ink});
          }
          x+=widths[i];
        });
        page.drawLine({start:{x:margin,y:y-height},end:{x:pageWidth-margin,y:y-height},thickness:.4,color:border});
        y-=height;
      }
      heading(block.title);row(block.headers,'header',true);
      for(const item of block.rows)row(Array.isArray(item)?item:item.values,item.kind);
      y-=16;
    }
    newPage();
    paragraph(report.period,10,true);paragraph(report.publication,8);paragraph(report.filters,9);
    paragraph(report.indicators.join('   |   '),9,true);
    paragraph('Rendimiento ponderado: suma de KM / suma de litros de las mismas filas con KM >= 0 y litros > 0. Los datos ausentes se muestran como —.',8);
    for(const block of report.blocks){
      if(block.type==='table')table(block);
      else if(block.type==='figure'){
        const image=await pdf.embedPng(await rasterize(block));
        const width=Math.min(available,block.width*.85),height=block.height*width/block.width;
        const noteHeight=wrap(block.note,available,8).length*12;
        ensure(height+noteHeight+42);heading(block.title);
        page.drawImage(image,{x:margin,y:y-height,width,height});y-=height+6;
        if(block.note)paragraph(block.note,8);y-=8;
      }else if(block.type==='distribution'){
        ensure(90);heading(block.title);
        const total=block.items.reduce((sum,item)=>sum+item.count,0);let x=margin;
        for(const item of block.items){
          const hex=item.color.slice(1),color=rgb(parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255),width=item.count/total*available;
          page.drawRectangle({x,y:y-22,width,height:22,color});x+=width;
        }
        y-=35;paragraph(block.items.map(item=>`${item.name}: ${item.count} (${(item.count/total*100).toLocaleString('es-CL',{maximumFractionDigits:1})} %)` ).join('   |   '),9);
      }else paragraph(block.text,9);
    }
    const pages=pdf.getPages();
    pages.forEach((sheet,i)=>{
      sheet.drawLine({start:{x:margin,y:27},end:{x:pageWidth-margin,y:27},thickness:.5,color:border});
      sheet.drawText('Resiter Driver · '+safe(report.scope),{x:margin,y:15,size:7,font:regular,color:grey});
      const label=`Página ${i+1} de ${pages.length}`;
      sheet.drawText(label,{x:pageWidth-margin-regular.widthOfTextAtSize(label,8),y:15,size:8,font:regular,color:grey});
    });
    return pdf.save();
  }
  window.CombustiblePDF={create,figures};
})();
