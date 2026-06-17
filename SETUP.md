# Setup Instructions for Arkinity

This guide will walk you through setting up Arkinity on your computer.

## Prerequisites

- **Node.js v14+**: [Download](https://nodejs.org/)
- **Python 3.7+**: [Download](https://www.python.org/)

## Step-by-Step Setup

### Step 1: Prepare Your Videos

You have two options for organizing your videos:

#### Option A: Manual Organization (Recommended for Beginners)

1. Create a folder to hold your video categories, e.g.:
   - Windows: `C:\Users\YourName\Videos\categorized_videos`
   - macOS: `/Users/YourName/Videos/categorized_videos`
   - Linux: `/home/YourName/Videos/categorized_videos`

2. Inside, create subdirectories for categories:
   ```
   categorized_videos/
   ├── Luxury Clips/
   │   ├── video1.mp4
   │   ├── video2.mp4
   │   └── video3.mp4
   ├── Nature/
   │   ├── sunset.mp4
   │   └── ocean.webm
   └── Travel/
       ├── paris.mp4
       └── tokyo.mp4
   ```

3. Move your video files into these category folders

#### Option B: Automatic Organization (Advanced)

1. Create a folder with all uncategorized videos, e.g.:
   - Windows: `C:\Users\YourName\Videos\mixed_videos`
   - macOS: `/Users/YourName/Videos/mixed_videos`
   - Linux: `/home/YourName/Videos/mixed_videos`

2. The `catagorize.py` script will analyze and organize them automatically (see Step 4)

### Step 2: Configure the Application

Open `config.js` in the project folder and set your paths:

```javascript
// ============ EDIT THESE ============

// Set to your categorized videos folder
const VIDEO_SOURCE_DIR = "C:\\Users\\YourName\\Videos\\categorized_videos";

// Set to your uncategorized videos folder (only needed if using catagorize.py)
const MIXED_VIDEOS_DIR = "C:\\Users\\YourName\\Videos\\mixed_videos";
```

**For macOS/Linux users:**
```javascript
const VIDEO_SOURCE_DIR = "/Users/YourName/Videos/categorized_videos";
const MIXED_VIDEOS_DIR = "/Users/YourName/Videos/mixed_videos";
```

### Step 3: Install Dependencies

Open a terminal/PowerShell in the project folder and run:

```bash
npm install
```

This installs the required Node.js packages.

### Step 4: (Optional) Install Python Dependencies

If you want to use automatic video categorization:

```bash
pip install numpy scikit-learn
pip install opencv-python  # Optional: for better video analysis
```

### Step 5: Run the Application

Start the server:

```bash
npm start
```

You should see output like:
```
Server listening on http://localhost:3000
Built file map with 3 categories.
```

Open your browser and go to: **http://localhost:3000**

## Using the Application

### Navigation
- **Scroll**: Swipe or scroll to navigate between videos
- **Play/Pause**: Click on a video to play/pause
- **Audio**: Click "Enable Audio" in the top-right corner to allow sound
- **Like**: Click the ♥ button to like a video
- **Share**: Click the ⤴ button to share (demo purposes)
- **Comment**: Click the 💬 button to comment (demo purposes)

### How Recommendations Work

The application learns from your viewing:
1. **Watch Time**: The longer you watch, the more it registers your interest
2. **Likes**: Clicking likes strongly signals preference
3. **Skips**: Skipping videos tells the engine what you don't like
4. **Similar Content**: Videos similar to ones you like get recommended

## Troubleshooting

### "No videos found" Error

**Problem**: App shows "No videos found" message

**Solutions**:
1. Check your `config.js` file - verify `VIDEO_SOURCE_DIR` path is correct
2. Verify the folder exists on your computer
3. Make sure you have subdirectories with videos inside
   ```
   ❌ Wrong:
   categorized_videos/
     └── video.mp4
   
   ✅ Correct:
   categorized_videos/
     └── MyCategory/
         └── video.mp4
   ```

### Server Won't Start

**Problem**: Error when running `npm start`

**Solutions**:
```bash
# Check Node is installed
node --version

# Reinstall dependencies
rm -r node_modules
npm install

# Try a different port
PORT=3001 npm start
```

### Videos Don't Play

**Problem**: Videos appear but won't play

**Solutions**:
1. Ensure videos are in supported formats: `.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`
2. Check browser console for errors (Press F12)
3. Try a different browser
4. Verify video files aren't corrupted (try opening in a media player)

### Python Script Error

**Problem**: Error when running `catagorize.py`

**Solutions**:
```bash
# Verify Python is installed
python --version

# Install required packages
pip install numpy scikit-learn

# Run with full error details
python catagorize.py
```

## Advanced Configuration: Environment Variables

Instead of editing `config.js`, you can set environment variables:

### Windows PowerShell

```powershell
# Set environment variables
$env:VIDEO_SOURCE_DIR = "C:\Users\YourName\Videos\videos"
$env:MIXED_VIDEOS_DIR = "C:\Users\YourName\Videos\new_videos"

# Start the app
npm start
```

### macOS/Linux Terminal

```bash
# Set environment variables
export VIDEO_SOURCE_DIR="/Users/YourName/Videos/videos"
export MIXED_VIDEOS_DIR="/Users/YourName/Videos/new_videos"

# Start the app
npm start
```

### Windows Command Prompt (cmd)

```cmd
set VIDEO_SOURCE_DIR=C:\Users\YourName\Videos\videos
set MIXED_VIDEOS_DIR=C:\Users\YourName\Videos\new_videos
npm start
```

## Using Automatic Video Categorization

If you want the app to automatically organize your videos:

### Step 1: Configure Paths

Edit `catagorize.py` and set these variables:

```python
# Directory with uncategorized videos
mixed_clips_folder = r"C:\Users\YourName\Videos\mixed_videos"

# Where organized videos will be placed
categories_folder = r"C:\Users\YourName\Videos\categorized_videos"
```

### Step 2: Run the Script

```bash
python catagorize.py
```

The script will:
1. Analyze all videos
2. Cluster them into similar groups
3. Create category folders
4. Move videos to their categories
5. Generate a report

### Step 3: Start the App

```bash
npm start
```

Your categorized videos are now ready!

## Next Steps

- Read [README.md](README.md) for full documentation
- Customize UI by editing `styles.css`
- Add more videos to categories and refresh the app
- Experiment with different recommendation settings in `recommender.js`

## Getting Help

1. Check the troubleshooting section above
2. Look for error messages in the browser console (F12)
3. Check server logs in the terminal
4. Verify all paths are correct in `config.js`

---

Happy video watching! 🎬
