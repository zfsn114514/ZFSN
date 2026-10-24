using System.Drawing.Drawing2D;
namespace ZfsnCursor;

internal static class Palette
{
    public static readonly Color Background = Color.FromArgb(10, 14, 21), Panel = Color.FromArgb(18, 24, 34), Raised = Color.FromArgb(25, 33, 46), Line = Color.FromArgb(42, 53, 68), Red = Color.FromArgb(255, 102, 113), Yellow = Color.FromArgb(245, 231, 69), Cyan = Color.FromArgb(113, 221, 225), Text = Color.FromArgb(231, 237, 243), Muted = Color.FromArgb(135, 152, 174);
    public static GraphicsPath Round(RectangleF rect, float radius)
    {
        var p = new GraphicsPath(); float d = radius * 2;
        p.AddArc(rect.X, rect.Y, d, d, 180, 90); p.AddArc(rect.Right-d,rect.Y,d,d,270,90);
        p.AddArc(rect.Right-d,rect.Bottom-d,d,d,0,90); p.AddArc(rect.X,rect.Bottom-d,d,d,90,90); p.CloseFigure(); return p;
    }
    public static Image Image(string name) { using var stream = CursorScheme.Resource(".Assets." + name); using var image = System.Drawing.Image.FromStream(stream); return new Bitmap(image); }
}
internal sealed class MenuButton : Button
{
    bool hover;
    public bool Primary { get; set; }
    public bool Selected { get; set; }
    public MenuButton()
    {
        FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; BackColor = Palette.Panel; ForeColor = Palette.Text;
        Cursor = Cursors.Hand; Height = 44; Width = 160; Margin = new Padding(0, 0, 10, 0);
        SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g=e.Graphics; g.SmoothingMode=SmoothingMode.AntiAlias; g.Clear(BackColor);
        using var shape=Palette.Round(new RectangleF(1,1,Width-3,Height-3),8);
        Color fill=Primary?Palette.Yellow:Selected?Color.FromArgb(40,43,34):hover?Palette.Raised:Palette.Panel;
        using var brush=new SolidBrush(fill); g.FillPath(brush,shape);
        using var pen=new Pen(Focused||Selected?Palette.Yellow:hover?Palette.Muted:Palette.Line); g.DrawPath(pen,shape);
        TextRenderer.DrawText(g,Text,Font,ClientRectangle,Primary?Palette.Background:Selected?Palette.Yellow:ForeColor,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
    }
}
internal sealed class OptionToggle : CheckBox
{
    public string Description { get; set; } = "";
    float position;
    readonly System.Windows.Forms.Timer animation = new() { Interval=16 };
    public OptionToggle()
    {
        AutoSize=false; Height=78; Dock=DockStyle.Fill; Margin=new Padding(0,0,0,10); BackColor=Palette.Background;
        Cursor=Cursors.Hand; AccessibleRole=AccessibleRole.CheckButton;
        SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);
        animation.Tick += (_,_)=> { float target=Checked?1:0; position+=(target-position)*.28f; if(Math.Abs(target-position)<.01f){position=target;animation.Stop();} Invalidate(); };
    }
    protected override void OnCheckedChanged(EventArgs e) { if(IsHandleCreated) animation.Start(); else position=Checked?1:0; Invalidate(); base.OnCheckedChanged(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g=e.Graphics; g.SmoothingMode=SmoothingMode.AntiAlias; g.Clear(BackColor);
        float scale=DeviceDpi/96f; int S(float n)=>(int)(n*scale);
        using var card=Palette.Round(new RectangleF(1,1,Width-3,Height-3),S(10));
        using var surface=new SolidBrush(Palette.Panel);g.FillPath(surface,card);
        using var border=new Pen(Focused?Palette.Yellow:Palette.Line);g.DrawPath(border,card);
        int textWidth=Width-S(115);
        TextRenderer.DrawText(g,Text,Font,new Rectangle(S(20),S(14),textWidth,S(25)),Palette.Text,TextFormatFlags.EndEllipsis|TextFormatFlags.SingleLine);
        using var small=new Font(Font.FontFamily,8.5f);
        TextRenderer.DrawText(g,Description,small,new Rectangle(S(20),S(42),textWidth,S(22)),Palette.Muted,TextFormatFlags.EndEllipsis|TextFormatFlags.SingleLine);
        var track=new RectangleF(Width-S(76),(Height-S(26))/2f,S(48),S(26));
        using var rounded=Palette.Round(track,S(13)); using var trackBrush=new SolidBrush(Checked?Palette.Cyan:Color.FromArgb(53,65,83));g.FillPath(trackBrush,rounded);
        using var dot=new SolidBrush(Checked?Palette.Background:Palette.Text);g.FillEllipse(dot,track.X+S(4)+S(22)*position,track.Y+S(4),S(18),S(18));
    }
    protected override void Dispose(bool disposing) { if(disposing)animation.Dispose();base.Dispose(disposing); }
}
internal sealed class IntensitySlider : Control
{
    int value=100;
    bool dragging;
    public event EventHandler? ValueChanged;
    public int Value { get=>value; set { int next=Math.Clamp(value,10,100); if(this.value==next)return;this.value=next;Invalidate();ValueChanged?.Invoke(this,EventArgs.Empty); } }
    public IntensitySlider() { Height=52; TabStop=true; Cursor=Cursors.Hand; BackColor=Palette.Panel; AccessibleRole=AccessibleRole.Slider; SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw|ControlStyles.Selectable,true); }
    int Inset => (int)(16*DeviceDpi/96f);
    void MoveValue(int x) => Value=10+(int)Math.Round(Math.Clamp((x-Inset)/(double)Math.Max(1,Width-2*Inset),0,1)*90);
    protected override void OnMouseDown(MouseEventArgs e) { if(e.Button!=MouseButtons.Left)return;Focus();dragging=true;Capture=true;MoveValue(e.X);base.OnMouseDown(e); }
    protected override void OnMouseMove(MouseEventArgs e) { if(dragging)MoveValue(e.X);base.OnMouseMove(e); }
    protected override void OnMouseUp(MouseEventArgs e) { dragging=false;Capture=false;base.OnMouseUp(e); }
    protected override void OnMouseCaptureChanged(EventArgs e) { if(!Capture)dragging=false;base.OnMouseCaptureChanged(e); }
    protected override void OnMouseWheel(MouseEventArgs e) { Value+=Math.Sign(e.Delta)*5;base.OnMouseWheel(e); }
    protected override bool IsInputKey(Keys keyData) => (keyData&Keys.KeyCode) is Keys.Left or Keys.Right or Keys.Up or Keys.Down or Keys.Home or Keys.End || base.IsInputKey(keyData);
    protected override void OnKeyDown(KeyEventArgs e) { switch(e.KeyCode){case Keys.Left:case Keys.Down:Value-=5;break;case Keys.Right:case Keys.Up:Value+=5;break;case Keys.Home:Value=10;break;case Keys.End:Value=100;break;default:base.OnKeyDown(e);return;}e.Handled=true; }
    protected override void OnGotFocus(EventArgs e){Invalidate();base.OnGotFocus(e);}
    protected override void OnLostFocus(EventArgs e){Invalidate();base.OnLostFocus(e);}
    protected override void OnPaint(PaintEventArgs e)
    {
        var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(BackColor);int pad=Inset;float y=Height/2f,x=pad+(Width-2*pad)*(value-10)/90f;
        using var track=new Pen(Palette.Line,4){StartCap=LineCap.Round,EndCap=LineCap.Round};g.DrawLine(track,pad,y,Width-pad,y);
        using var fill=new Pen(Palette.Cyan,4){StartCap=LineCap.Round,EndCap=LineCap.Round};g.DrawLine(fill,pad,y,x,y);
        using var halo=new SolidBrush(Color.FromArgb(Focused?50:24,Palette.Cyan));g.FillEllipse(halo,x-12,y-12,24,24);
        using var dot=new SolidBrush(Palette.Cyan);g.FillEllipse(dot,x-6,y-6,12,12);
    }
}
internal sealed class PreviewPanel : Control
{
    readonly Image arrow=Palette.Image("arrow.png");
    Point? pointer;
    public float Strength {get;set;}=1;
    public bool Halo {get;set;}=true;
    public bool WebCursor {get;set;}=true;
    public PreviewPanel() { DoubleBuffered=true;BackColor=Palette.Panel;Height=150;SetStyle(ControlStyles.ResizeRedraw,true); }
    protected override void OnMouseMove(MouseEventArgs e){pointer=e.Location;Invalidate();base.OnMouseMove(e);}
    protected override void OnMouseLeave(EventArgs e){pointer=null;Invalidate();base.OnMouseLeave(e);}
    protected override void OnPaint(PaintEventArgs e)
    {
        var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(BackColor);using var grid=new Pen(Color.FromArgb(22,Palette.Muted));
        for(int x=0;x<Width;x+=24)g.DrawLine(grid,x,0,x,Height);for(int y=0;y<Height;y+=24)g.DrawLine(grid,0,y,Width,y);
        Point p=pointer??new Point(Width*2/3,Height/2);
        if(Halo){using var circle=new GraphicsPath();circle.AddEllipse(p.X-95,p.Y-95,190,190);using var light=new PathGradientBrush(circle){CenterColor=Color.FromArgb(35,Palette.Red),SurroundColors=new[]{Color.Transparent}};g.FillPath(light,circle);}
        for(int i=12;i>0;i--){using var glow=new SolidBrush(Color.FromArgb((int)((90-i*6)*Strength),Palette.Red));float r=2+(12-i)*.25f;g.FillEllipse(glow,p.X-i*9-r,p.Y+(float)Math.Sin(i*.3)*13-r,r*2,r*2);}
        if(WebCursor)g.DrawImage(arrow,new Rectangle(p.X-4,p.Y-2,32,32));else{using var neutral=new SolidBrush(Palette.Text);g.FillPolygon(neutral,new Point[]{p,new(p.X+5,p.Y+23),new(p.X+11,p.Y+15),new(p.X+20,p.Y+13)});}
        using var font=new Font("Consolas",8);TextRenderer.DrawText(g,"POINTER / PREVIEW",font,new Point(16,14),Palette.Muted);
    }
    protected override void Dispose(bool disposing){if(disposing)arrow.Dispose();base.Dispose(disposing);}
}
internal sealed class TrayRenderer : ToolStripProfessionalRenderer
{
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e){e.Graphics.Clear(Palette.Panel);}
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e){using var b=new SolidBrush(e.Item.Selected?Palette.Raised:Palette.Panel);e.Graphics.FillRectangle(b,new Rectangle(Point.Empty,e.Item.Size));}
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e){e.TextColor=e.Item.Selected?Palette.Yellow:Palette.Text;base.OnRenderItemText(e);}
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e){using var p=new Pen(Palette.Line);e.Graphics.DrawRectangle(p,0,0,e.ToolStrip.Width-1,e.ToolStrip.Height-1);}
}

internal sealed class SurfaceLayout : TableLayoutPanel
{
    public SurfaceLayout(){DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw,true);}
    protected override void OnPaintBackground(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;e.Graphics.Clear(Parent?.BackColor??Palette.Background);
        using var shape=Palette.Round(new RectangleF(1,1,Width-3,Height-3),10*DeviceDpi/96f);
        using var surface=new SolidBrush(Palette.Panel);e.Graphics.FillPath(surface,shape);
        using var border=new Pen(Palette.Line);e.Graphics.DrawPath(border,shape);
    }
}
